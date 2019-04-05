import { app } from "@arkecosystem/core-container";
import { P2P } from "@arkecosystem/core-interfaces";
import SocketCluster from "socketcluster";
import { SocketErrors } from "../enums";
import { getHeaders } from "./utils/get-headers";

export const startSocketServer = async (service: P2P.IPeerService, config) => {
    const peerHandlers = require("./versions/peer");
    const internalHandlers = require("./versions/internal");
    const utilsHandlers = require("./versions/utils");

    // when testing we also need to get socket files from dist folder
    const relativeSocketPath = process.env.CORE_ENV === "test" ? "/../../dist/socket-server" : "";

    const server = new SocketCluster({
        workers: config.workers || 1,
        brokers: 1,
        port: config.port,
        appName: "core-p2p",
        wsEngine: "ws",
        workerController: __dirname + `${relativeSocketPath}/worker.js`,
        rebootWorkerOnCrash: true,
    });

    // socketcluster types do not allow on("workerMessage") so casting as any
    (server as any).on("workerMessage", async (workerId, req, res) => {
        // special endpoint for worker init, when need to get plugin config
        if (req.endpoint === "p2p.init.getConfig") {
            return res(null, config);
        }

        const handlers = {
            peer: peerHandlers,
            internal: internalHandlers,
            utils: utilsHandlers, // not publicly exposed, only used between worker / master
        };

        const [prefix, version, method] = req.endpoint.split(".");

        try {
            const result = {
                data: (await handlers[version][method](service, req)) || {},
                headers: getHeaders(),
            };

            return res(null, result);
        } catch (e) {
            const logger = app.resolvePlugin("logger");
            logger.error(e);

            // return explicit error when data validation error
            if (e.name === SocketErrors.Validation) {
                return res(e);
            }
            return res(new Error(`Socket call to ${req.endpoint} failed.`));
        }
    });

    // Create a timeout promise so that if socket server is not ready in 10 seconds, it rejects
    const timeoutPromise = new Promise((resolve, reject) => {
        const id = setTimeout(() => {
            clearTimeout(id);
            reject("Socket server failed to setup in 10 seconds.");
        }, 10000);
    });
    const serverReadyPromise = new Promise((resolve, reject) => {
        server.on("ready", () => resolve(server));
    });

    return Promise.race([serverReadyPromise, timeoutPromise]);
};