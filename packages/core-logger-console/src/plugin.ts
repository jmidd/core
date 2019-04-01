import { Container } from "@arkecosystem/core-interfaces";
import { LoggerManager } from "@arkecosystem/core-logger";
import { ConsoleLogger } from "./driver";

export const plugin: Container.PluginDescriptor = {
    pkg: require("../package.json"),
    alias: "logger",
    extends: "@arkecosystem/core-logger",
    async register(container: Container.IContainer, options) {
        return container.resolvePlugin<LoggerManager>("log-manager").createDriver(new ConsoleLogger(options));
    },
};
