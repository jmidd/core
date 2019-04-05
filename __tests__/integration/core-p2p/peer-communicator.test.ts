import "jest-extended";

import "./mocks/core-container";

import { P2P } from "@arkecosystem/core-interfaces";
import { Peer } from "../../../packages/core-p2p/src/peer";
import { makePeerService } from "../../../packages/core-p2p/src/plugin";
import { TransactionFactory } from "../../helpers/transaction-factory";
import genesisBlockJSON from "../../utils/config/unitnet/genesisBlock.json";
import { delegates } from "../../utils/fixtures/unitnet";
import { MockSocketManager } from "./__support__/mock-socket-server/manager";

let stubPeer: P2P.IPeer;
let localConfig;
let socketManager: MockSocketManager;

let storage;
let communicator;
beforeAll(async () => {
    socketManager = new MockSocketManager();
    await socketManager.init();

    localConfig = require("../../../packages/core-p2p/src/config").config;

    localConfig.init({});
    localConfig.set("port", 4009); // we mock a peer on localhost:4009
    localConfig.set("blacklist", []);
    localConfig.set("minimumVersions", [">=2.1.0"]);
});

afterAll(async () => {
    socketManager.stopServer();
});

beforeEach(() => {
    const service = makePeerService();
    storage = service.getStorage();
    communicator = service.getCommunicator();

    stubPeer = new Peer("127.0.0.1", 4009);
    stubPeer.nethash = "a63b5a3858afbca23edefac885be74d59f1a26985548a4082f4f479e74fcc348";
    storage.setPeer(stubPeer);
});

afterEach(() => socketManager.resetAllMocks());

describe("PeerCommunicator", () => {
    describe("postBlock", () => {
        it("should get back success when posting genesis block", async () => {
            await socketManager.addMock("postBlock", { success: true });
            const response = await communicator.postBlock(stubPeer, genesisBlockJSON);

            expect(response).toBeObject();
            expect(response).toHaveProperty("success");
            expect(response.success).toBeTrue();
        });
    });

    describe("postTransactions", () => {
        it("should be ok", async () => {
            await socketManager.addMock("postTransactions", { success: true, transactionsIds: [] });
            const transactions = TransactionFactory.transfer(delegates[2].address, 1000)
                .withNetwork("testnet")
                .withPassphrase(delegates[1].passphrase)
                .create(1);

            const response = await communicator.postTransactions(stubPeer, transactions);

            expect(response).toBeObject();
            expect(response).toHaveProperty("success");
            expect(response.success).toBeTrue();
        });
    });

    describe("downloadBlocks", () => {
        it("should return the blocks with status 200", async () => {
            await socketManager.addMock("getBlocks", { blocks: [genesisBlockJSON] });
            const response = await communicator.downloadBlocks(stubPeer, 1);

            expect(response).toBeArrayOfSize(1);
            expect(response[0].id).toBe(genesisBlockJSON.id);
        });

        it("should update the height after download", async () => {
            await socketManager.addMock("getBlocks", { blocks: [genesisBlockJSON] });

            stubPeer.state.height = null;
            await communicator.downloadBlocks(stubPeer, 1);

            expect(stubPeer.state.height).toBe(1);
        });
    });

    describe("ping", () => {
        it("should be ok", async () => {
            const mockStatus = {
                success: true,
                height: 1,
                forgingAllowed: true,
                currentSlot: 1,
                header: {
                    height: 1,
                    id: "123456",
                },
            };
            await socketManager.addMock("getStatus", mockStatus);
            process.env.CORE_SKIP_PEER_STATE_VERIFICATION = "true";

            const status = await communicator.ping(stubPeer, 1000);

            expect(status).toEqual(mockStatus);
        });

        it.skip("when ping request timeouts", async () => {
            await socketManager.resetAllMocks();

            process.env.CORE_SKIP_PEER_STATE_VERIFICATION = "true";

            await communicator.ping(stubPeer, 400);
        });
    });

    describe("recentlyPinged", () => {
        it("should return true after a ping", async () => {
            const mockStatus = {
                success: true,
                height: 1,
                forgingAllowed: true,
                currentSlot: 1,
                header: {
                    height: 1,
                    id: "123456",
                },
            };
            await socketManager.addMock("getStatus", mockStatus);

            stubPeer.lastPinged = null;

            expect(communicator.recentlyPinged(stubPeer)).toBeFalse();

            const response = await communicator.ping(stubPeer, 5000);

            expect(response).toBeObject();
            expect(response).toHaveProperty("success");
            expect(response.success).toBeTrue();
            expect(communicator.recentlyPinged(stubPeer)).toBeTrue();
        });
    });

    describe("getPeers", () => {
        it("should return the list of peers", async () => {
            const peersMock = [{ ip: "1.1.1.1" }];

            await socketManager.addMock("getPeers", { success: true, peers: peersMock });

            const peers = await communicator.getPeers(stubPeer);

            expect(peers).toEqual(peersMock);
        });
    });

    describe("hasCommonBlocks", () => {
        it("should return false when peer has no common block", async () => {
            await socketManager.addMock("getCommonBlocks", { success: true, common: null });

            const commonBlocks = await communicator.hasCommonBlocks(stubPeer, [genesisBlockJSON.id]);

            expect(commonBlocks).toBeFalse();
        });

        it("should return true when peer has common block", async () => {
            await socketManager.resetAllMocks();
            await socketManager.addMock("getCommonBlocks", { success: true, common: genesisBlockJSON });

            const commonBlocks = await communicator.hasCommonBlocks(stubPeer, [genesisBlockJSON.id]);

            expect(commonBlocks).toEqual(genesisBlockJSON);
        });
    });
});