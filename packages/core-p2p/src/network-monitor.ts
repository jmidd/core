/* tslint:disable:max-line-length */

import { app } from "@arkecosystem/core-container";
import { Blockchain, EventEmitter, Logger, P2P } from "@arkecosystem/core-interfaces";
import { slots } from "@arkecosystem/crypto";
import { dato, Dato } from "@faustbrian/dato";
import delay from "delay";
import groupBy from "lodash.groupby";
import sample from "lodash.sample";
import shuffle from "lodash.shuffle";
import take from "lodash.take";
import pluralize from "pluralize";
import prettyMs from "pretty-ms";
import { config as localConfig } from "./config";
import { NetworkState } from "./network-state";
import { checkDNS, checkNTP, restorePeers } from "./utils";

export class NetworkMonitor implements P2P.INetworkMonitor {
    public server: any;
    public config: any;
    public nextUpdateNetworkStatusScheduled: boolean;
    private initializing: boolean = true;
    private coldStartPeriod: Dato;

    private readonly appConfig = app.getConfig();
    private readonly logger: Logger.ILogger = app.resolvePlugin<Logger.ILogger>("logger");
    private readonly emitter: EventEmitter.EventEmitter = app.resolvePlugin<EventEmitter.EventEmitter>("event-emitter");

    constructor(
        private readonly storage: P2P.IPeerStorage,
        private readonly processor: P2P.IPeerProcessor,
        private readonly communicator: P2P.IPeerCommunicator,
    ) {
        this.coldStartPeriod = dato().addSeconds(localConfig.get("coldStart"));
    }

    public async start(options): Promise<this> {
        this.config = options;

        await this.checkDNSConnectivity(options.dns);
        await this.checkNTPConnectivity(options.ntp);

        const cachedPeers = restorePeers();
        localConfig.set("peers", cachedPeers);

        await this.populateSeedPeers();

        if (this.config.skipDiscovery) {
            this.logger.warn("Skipped peer discovery because the relay is in skip-discovery mode.");
        } else {
            await this.updateNetworkStatus(options.networkStart);

            for (const [version, peers] of Object.entries(groupBy(this.storage.getPeers(), "version"))) {
                this.logger.info(`Discovered ${pluralize("peer", peers.length, true)} with v${version}.`);
            }
        }

        this.initializing = false;
        return this;
    }

    public async updateNetworkStatus(networkStart: boolean = false): Promise<void> {
        if (process.env.CORE_ENV === "test" || process.env.NODE_ENV === "test") {
            return;
        }

        if (networkStart) {
            this.logger.warn("Skipped peer discovery because the relay is in genesis-start mode.");
            return;
        }

        if (this.config.disableDiscovery) {
            this.logger.warn("Skipped peer discovery because the relay is in non-discovery mode.");
            return;
        }

        try {
            await this.discoverPeers();
            await this.cleanPeers();
        } catch (error) {
            this.logger.error(`Network Status: ${error.message}`);
        }

        let nextRunDelaySeconds = 600;

        if (!this.hasMinimumPeers()) {
            await this.populateSeedPeers();
            nextRunDelaySeconds = 5;
            this.logger.info(`Couldn't find enough peers. Falling back to seed peers.`);
        }

        this.scheduleUpdateNetworkStatus(nextRunDelaySeconds);
    }

    public async cleanPeers(fast = false, forcePing = false): Promise<void> {
        const keys = Object.keys(this.storage.getPeers());
        let unresponsivePeers = 0;
        const pingDelay = fast ? 1500 : localConfig.get("globalTimeout");
        const max = keys.length;

        this.logger.info(`Checking ${max} peers`);
        const peerErrors = {};
        await Promise.all(
            keys.map(async ip => {
                const peer = this.storage.getPeer(ip);
                try {
                    await this.communicator.ping(peer, pingDelay, forcePing);
                } catch (error) {
                    unresponsivePeers++;

                    if (peerErrors[error]) {
                        peerErrors[error].push(peer);
                    } else {
                        peerErrors[error] = [peer];
                    }

                    this.emitter.emit("peer.removed", peer);

                    this.storage.forgetPeer(peer);

                    return null;
                }
            }),
        );

        Object.keys(peerErrors).forEach((key: any) => {
            const peerCount = peerErrors[key].length;
            this.logger.debug(`Removed ${peerCount} ${pluralize("peers", peerCount)} because of "${key}"`);
        });

        if (this.initializing) {
            this.logger.info(`${max - unresponsivePeers} of ${max} peers on the network are responsive`);
            this.logger.info(`Median Network Height: ${this.getNetworkHeight().toLocaleString()}`);
            this.logger.info(`Network PBFT status: ${this.getPBFTForgingStatus()}`);
        }
    }

    public async discoverPeers(): Promise<void> {
        const queryAtLeastNPeers = 4;
        let queriedPeers = 0;

        const shuffledPeers = shuffle(this.storage.getPeers());

        for (const peer of shuffledPeers) {
            try {
                const hisPeers = await this.communicator.getPeers(peer);
                queriedPeers++;
                await Promise.all(hisPeers.map(p => this.processor.validateAndAcceptPeer(p, { lessVerbose: true })));
            } catch (error) {
                // Just try with the next peer from shuffledPeers.
            }

            if (this.hasMinimumPeers() && queriedPeers >= queryAtLeastNPeers) {
                return;
            }
        }
    }

    public getNetworkHeight(): number {
        const medians = this.storage
            .getPeers()
            .filter(peer => peer.state.height)
            .map(peer => peer.state.height)
            .sort((a, b) => a - b);

        return medians[Math.floor(medians.length / 2)] || 0;
    }

    public getPBFTForgingStatus(): number {
        const height = this.getNetworkHeight();
        const slot = slots.getSlotNumber();

        let allowedToForge = 0;
        let syncedPeers = 0;

        for (const peer of this.storage.getPeers()) {
            if (peer.state) {
                if (peer.state.currentSlot === slot) {
                    syncedPeers++;

                    if (peer.state.forgingAllowed && peer.state.height >= height) {
                        allowedToForge++;
                    }
                }
            }
        }

        const pbft = allowedToForge / syncedPeers;

        return isNaN(pbft) ? 0 : pbft;
    }

    public async getNetworkState(): Promise<P2P.INetworkState> {
        if (!this.isColdStartActive()) {
            await this.cleanPeers(true, true);
        }

        return NetworkState.analyze(this, this.storage);
    }

    public async refreshPeersAfterFork(): Promise<void> {
        this.logger.info(`Refreshing ${this.storage.getPeers().length} peers after fork.`);

        // Reset all peers, except peers banned because of causing a fork.
        await this.cleanPeers(false, true);
        // @TODO: move this out of the processor
        await this.processor.resetSuspendedPeers();

        // Ban peer who caused the fork
        const forkedBlock = app.resolve("state").forkedBlock;
        if (forkedBlock) {
            this.processor.suspend(forkedBlock.ip);
        }
    }

    public async checkNetworkHealth(): Promise<P2P.INetworkStatus> {
        if (!this.isColdStartActive()) {
            await this.cleanPeers(false, true);
            await this.processor.resetSuspendedPeers();
        }

        const lastBlock = app.resolve("state").getLastBlock();

        const peers = this.storage.getPeers();
        const suspendedPeers = Object.values(this.storage.getSuspendedPeers())
            .map((suspendedPeer: any) => suspendedPeer.peer)
            .filter(peer => peer.verification !== null);

        const allPeers = [...peers, ...suspendedPeers];
        if (!allPeers.length) {
            this.logger.info("No peers available.");
            return { forked: false };
        }

        const forkedPeers = allPeers.filter(peer => peer.verification.forked);
        const majorityOnOurChain = forkedPeers.length / allPeers.length < 0.5;

        if (majorityOnOurChain) {
            this.logger.info("The majority of peers is not forked. No need to rollback.");
            return { forked: false };
        }

        const groupedByCommonHeight = groupBy(allPeers, "verification.highestCommonHeight");

        const groupedByLength = groupBy(Object.values(groupedByCommonHeight), "length");

        // Sort by longest
        // @ts-ignore
        const longest = Object.keys(groupedByLength).sort((a, b) => b - a)[0];
        const longestGroups = groupedByLength[longest];

        // Sort by highest common height DESC
        longestGroups.sort((a, b) => b[0].verification.highestCommonHeight - a[0].verification.highestCommonHeight);
        const peersMostCommonHeight = longestGroups[0];

        const { highestCommonHeight } = peersMostCommonHeight[0].verification;
        this.logger.info(
            `Rolling back to most common height ${highestCommonHeight}. Own height: ${lastBlock.data.height}`,
        );

        // Now rollback blocks equal to the distance to the most common height.
        const blocksToRollback = lastBlock.data.height - highestCommonHeight;
        return { forked: true, blocksToRollback };
    }

    public isColdStartActive(): boolean {
        return this.coldStartPeriod.isAfter(dato());
    }

    // @TODO: review and move into an appropriate class
    public async syncWithNetwork(fromBlockHeight: number): Promise<any> {
        try {
            const peersAll = this.storage.getPeers();
            const peersFiltered = peersAll.filter(peer => !this.storage.hasSuspendedPeer(peer.ip) && !peer.isForked());

            if (peersFiltered.length === 0) {
                throw new Error(
                    `Failed to pick a random peer from our list of ${peersAll.length} peers: ` +
                        `all are either banned or on a different chain than us`,
                );
            }

            return this.communicator.downloadBlocks(sample(peersFiltered), fromBlockHeight);
        } catch (error) {
            this.logger.error(`Could not download blocks: ${error.message}`);

            return this.syncWithNetwork(fromBlockHeight);
        }
    }

    // @TODO: review and move into an appropriate class
    public async broadcastBlock(block): Promise<void> {
        const blockchain = app.resolvePlugin<Blockchain.IBlockchain>("blockchain");

        if (!blockchain) {
            this.logger.info(
                `Skipping broadcast of block ${block.data.height.toLocaleString()} as blockchain is not ready`,
            );
            return;
        }

        let blockPing = blockchain.getBlockPing();
        let peers = this.storage.getPeers();

        if (blockPing && blockPing.block.id === block.data.id) {
            // wait a bit before broadcasting if a bit early
            const diff = blockPing.last - blockPing.first;
            const maxHop = 4;
            let proba = (maxHop - blockPing.count) / maxHop;

            if (diff < 500 && proba > 0) {
                await delay(500 - diff);

                blockPing = blockchain.getBlockPing();

                // got aleady a new block, no broadcast
                if (blockPing.block.id !== block.data.id) {
                    return;
                }

                proba = (maxHop - blockPing.count) / maxHop;
            }

            // TODO: to be put in config?
            peers = peers.filter(p => Math.random() < proba);
        }

        this.logger.info(
            `Broadcasting block ${block.data.height.toLocaleString()} to ${pluralize("peer", peers.length, true)}`,
        );

        await Promise.all(peers.map(peer => this.communicator.postBlock(peer, block.toJson())));
    }

    // @TODO: review and move into an appropriate class
    public async broadcastTransactions(transactions): Promise<any> {
        const peers = take(shuffle(this.storage.getPeers()), localConfig.get("maxPeersBroadcast"));

        this.logger.debug(
            `Broadcasting ${pluralize("transaction", transactions.length, true)} to ${pluralize(
                "peer",
                peers.length,
                true,
            )}`,
        );

        transactions = transactions.map(transaction => transaction.toJson());

        return Promise.all(peers.map(peer => this.communicator.postTransactions(peer, transactions)));
    }

    public getServer(): any {
        return this.server;
    }

    public setServer(server: any): void {
        this.server = server;
    }

    private async checkDNSConnectivity(options): Promise<void> {
        try {
            const host = await checkDNS(options);

            this.logger.info(`Your network connectivity has been verified by ${host}`);
        } catch (error) {
            this.logger.error(error.message);
        }
    }

    private async checkNTPConnectivity(options): Promise<void> {
        try {
            const { host, time } = await checkNTP(options);

            this.logger.info(`Your NTP connectivity has been verified by ${host}`);

            this.logger.info(`Local clock is off by ${time.t < 0 ? "-" : ""}${prettyMs(Math.abs(time.t))} from NTP`);
        } catch (error) {
            this.logger.error(error.message);
        }
    }

    private async scheduleUpdateNetworkStatus(nextUpdateInSeconds): Promise<void> {
        if (this.nextUpdateNetworkStatusScheduled) {
            return;
        }

        this.nextUpdateNetworkStatusScheduled = true;

        await delay(nextUpdateInSeconds * 1000);

        this.nextUpdateNetworkStatusScheduled = false;

        this.updateNetworkStatus(this.config.networkStart);
    }

    private hasMinimumPeers(): boolean {
        if (this.config.ignoreMinimumNetworkReach) {
            this.logger.warn("Ignored the minimum network reach because the relay is in seed mode.");

            return true;
        }

        return Object.keys(this.storage.getPeers()).length >= localConfig.get("minimumNetworkReach");
    }

    // @TODO: review and move into an appropriate class
    private async populateSeedPeers(): Promise<any> {
        const peerList = this.appConfig.get("peers.list");

        if (!peerList) {
            app.forceExit("No seed peers defined in peers.json");
        }

        const peers = peerList.map(peer => {
            peer.version = app.getVersion();
            return peer;
        });

        const localConfigPeers = localConfig.get("peers");
        if (localConfigPeers) {
            localConfigPeers.forEach(peerA => {
                if (!peers.some(peerB => peerA.ip === peerB.ip && peerA.port === peerB.port)) {
                    peers.push(peerA);
                }
            });
        }

        return Promise.all(
            Object.values(peers).map((peer: any) => {
                this.storage.forgetPeer(peer);
                return this.processor.validateAndAcceptPeer(peer, { seed: true, lessVerbose: true });
            }),
        );
    }
}