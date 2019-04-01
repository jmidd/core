import { Logger } from "@arkecosystem/core-interfaces";
import { AbstractLogger } from "@arkecosystem/core-logger";

export class ConsoleLogger extends AbstractLogger {
    protected logger: Console;

    public make(): Logger.ILogger {
        this.logger = console;

        return this;
    }

    protected getLevels(): Record<string, string> {
        return {
            verbose: "trace",
        };
    }
}
