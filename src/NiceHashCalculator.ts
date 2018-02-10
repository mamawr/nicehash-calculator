import chalk from "chalk";
import * as fs from "fs";

import * as NiceHash from "./apis/nicehash";
import * as WhatToMine from "./apis/whattomine";
import { getCoins as getWhatToMineCoins, ICoin } from "./coins";
import { debug, state as _debugState } from "./debug";
import { AbstractHandler } from "./handlers/AbstractHandler";
import { JSONHandler } from "./handlers/JSONHandler";
import { UnifiedHandler } from "./handlers/UnifiedHandler";
import { IOptions, parse as _parseOptions } from "./options";
import { getGlobalNiceHashPrices } from "./price";
import { getWhatToMineRevenue } from "./revenue";
import { sleep } from "./utils";

const BUG_REPORTS = "https://github.com/GarboMuffin/nicehash-calculator/issues/new";

export interface ICoinData {
  coin: ICoin;
  revenue: WhatToMine.IRevenueResponse;
  profit: number;
  price: number;
  returnOnInvestment: number;
  percentChange: number;
}

export class NiceHashCalculator {
  public options: IOptions;
  public whatToMine: WhatToMine.API = new WhatToMine.API();
  public niceHash: NiceHash.API = new NiceHash.API();
  private globalNiceHashPrices: number[] = [];

  constructor() {
    this.options = this.parseOptions();

    if (this.options.showHeader) {
      console.log(`This program ${chalk.bold("**estimates**")} the profitability of buying hashing power on NiceHash`);
      console.log(`Estimations are based on the NiceHash and WhatToMine APIs and have no guarantee of accuracy.`);
      console.log(`Only spend what you can afford to lose. I am not responsible for any losses.`);
      console.log("");
      console.log("BTC: " + chalk.underline("1GarboYPsadWuEi8B2Pv1SvwAsBHVn1ABZ"));
      console.log("");
      console.log("Please report bugs: " + chalk.underline(BUG_REPORTS));
      console.log("");
    }

    if (this.options.userAgent !== "") {
      this.whatToMine.USER_AGENT = this.options.userAgent;
    }

    if (this.options.debug) {
      _debugState.enabled = true;
    }

    for (const unrecognizedOption of this.options.unrecognized) {
      console.warn("Unrecognized option: " + unrecognizedOption);
    }
  }

  public async start() {
    const whatToMineCoins = await getWhatToMineCoins(this);
    this.globalNiceHashPrices = await getGlobalNiceHashPrices(this);

    if (this.options.useCoinCache) {
      await this.whatToMine.populateCoinRevenueCache();
    }

    const coins = this.filterCoins(whatToMineCoins);
    const outputHandler = this.chooseHandler();

    if (this.usingMinimumPrices) {
      console.log(chalk.yellow("Calculating prices using lowest order with workers. This is discouraged."));
      console.log("");
    }

    for (const coin of coins) {
      // Calculate the numbers
      const revenueData = await getWhatToMineRevenue(coin, this);
      const revenue = revenueData.revenue;
      const price = await this.getAlgoPrice(coin.niceHashAlgo);
      const profit = revenue - price;

      const returnOnInvestment = revenue / price;
      const percentChange = returnOnInvestment - 1;

      // data is now passed onto any handlers
      const data: ICoinData = {
        coin,
        revenue: revenueData,
        price,
        profit,
        returnOnInvestment,
        percentChange,
      };

      outputHandler.handle(data, this);

      // Only sleep when not on the last coin
      const isLastCoin = coins.indexOf(coin) === coins.length - 1;
      if (!isLastCoin) {
        await sleep(this.options.sleepTime);
      }
    }

    outputHandler.finished(this);
  }

  private async getAlgoPrice(algo: NiceHash.Algorithm): Promise<number> {
    if (this.usingMinimumPrices) {
      return await this.niceHash.getAlgoMinimumPrice(algo);
    } else {
      return this.globalNiceHashPrices[algo.id];
    }
  }

  // Option related things
  private filterCoins(allCoins: ICoin[]): ICoin[] {
    // I've worked on this a bit and it's complicated.

    // Here's what I want:
    // [X] If a user types in an algorithm it enables all coins of that algorithm
    // [X] If a user types in the ticker/abbrevation of a coin it will enable it
    // [X] If a user types in the name of a coin it will enable it
    // [ ] maybe using levenshtein distance to be more safe?

    // // If none are specified then return all of them
    // // TODO: defaults to bitcoin, eth, ltc, equihash, etc.
    // if (this.options.coins.length === 0) {
    //   return allCoins;
    // }

    let result: ICoin[] = allCoins;
    let userEnabledCoins = false;

    for (const coin of allCoins) {
      for (const str of this.options.coins) {
        const isDisablingCoin = str.startsWith("-");

        let name: string = "";
        if (isDisablingCoin) {
          name = str.substr(1);
        } else {
          name = str;
        }

        if (coin.names.indexOf(name) > -1 || coin.niceHashAlgo.names.indexOf(name) > -1) {
          if (isDisablingCoin) {
            const index = result.indexOf(coin);
            if (index === -1) {
              console.warn(chalk.yellow(`WARN: Can't disable coin '${name}': not found`));
            } else {
              debug(`Disabling coin ${coin.displayName} because of argument '${str}'`);
              result.splice(index, 1);
            }
          } else {
            debug(`Enabled coin ${coin.displayName} because of argument '${str}'`);
            if (!userEnabledCoins) {
              result = [];
            }
            userEnabledCoins = true;
            result.push(coin);
            break;
          }
        }
      }
    }

    if (!userEnabledCoins) {
      return allCoins;
    }

    return result;
  }

  private chooseHandler(): AbstractHandler {
    if (this.options.useJsonOutput) {
      return new JSONHandler();
    }
    return new UnifiedHandler();
  }

  private parseOptions() {
    const readArgumentsFile = () => {
      const content = fs.readFileSync("arguments.txt");
      const lines = content.toString().split("\n");
      const result: string[] = [];

      for (const line of lines) {
        // Lines that starti with # are comments
        if (line.startsWith("#")) {
          continue;
        }
        // Trim it to avoid newlines and other characters
        const trimmed = line.trim();
        // Ignore empty lines
        if (trimmed === "") {
          continue;
        }
        result.push(trimmed);
      }

      return result;
    };

    // get the arguments to pass to the parser
    // remove the first 2 things from argv because that's node and this file
    let args = process.argv.splice(2);
    // append arguments.txt
    args = args.concat(readArgumentsFile());

    const options = _parseOptions(args);
    return options;
  }

  ///
  /// ACCESSORS
  ///

  get usingMinimumPrices(): boolean {
    return this.options.useMinimumPrices;
  }

  get inDebugMode(): boolean {
    return this.options.debug;
  }
}