import { Buffer } from "buffer";
import { AssembledTransaction, Client as ContractClient, ClientOptions as ContractClientOptions, MethodOptions, Result } from "@stellar/stellar-sdk/contract";
import type { u32, i128 } from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";
export declare const Errors: {
    1: {
        message: string;
    };
    2: {
        message: string;
    };
    3: {
        message: string;
    };
    4: {
        message: string;
    };
    5: {
        message: string;
    };
};
export type DataKey = {
    tag: "Resource";
    values: readonly [string];
} | {
    tag: "Count";
    values: void;
} | {
    tag: "Index";
    values: readonly [u32];
};
export interface Resource {
    creator: string;
    id: string;
    listed: boolean;
    metadata: string;
    price: i128;
    /**
     * Discovery labels (e.g. "dataset", "research"). Distinct from `metadata`,
     * which remains the off-chain content anchor (IPFS URI, content hash, etc.).
     */
    tags: Array<string>;
}
export interface Client {
    /**
     * Construct and simulate a get transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     * Fetch a resource. Errors with `NotFound` if it does not exist.
     */
    get: ({ id }: {
        id: string;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<Resource>>>;
    /**
     * Construct and simulate a list transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     * Paginated resource list in insertion order. `limit` is capped at 20.
     */
    list: ({ start, limit }: {
        start: u32;
        limit: u32;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Array<Resource>>>;
    /**
     * Construct and simulate a count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     * Total number of resources successfully registered (monotonic; not decremented on transfer).
     */
    count: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>;
    /**
     * Construct and simulate a delist transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     * Delist a resource (convenience method for set_listed(false)). Only the creator may call this.
     */
    delist: ({ id }: {
        id: string;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
    /**
     * Construct and simulate a exists transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     * Whether a resource with `id` is registered.
     */
    exists: ({ id }: {
        id: string;
    }, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>;
    /**
     * Construct and simulate a register transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     * Register a new resource. Errors if `id` already exists or `price <= 0`.
     * Requires the creator's authorization.
     */
    register: ({ creator, id, price, metadata, tags, }: {
        creator: string;
        id: string;
        price: i128;
        metadata: string;
        tags: Array<string>;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
    /**
     * Construct and simulate a set_tags transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     * Replace a resource's discovery tags. Only the creator may call this.
     * Does not modify `metadata` (the off-chain content pointer).
     */
    set_tags: ({ id, tags }: {
        id: string;
        tags: Array<string>;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
    /**
     * Construct and simulate a get_owner transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     * Get the owner address of a resource. Errors with `NotFound` if it does not exist.
     */
    get_owner: ({ id }: {
        id: string;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<string>>>;
    /**
     * Construct and simulate a set_price transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     * Update a resource's price. Only the creator may call this.
     */
    set_price: ({ id, new_price }: {
        id: string;
        new_price: i128;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
    /**
     * Construct and simulate a set_listed transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     * Set the listing state of a resource. Only the creator may call this.
     */
    set_listed: ({ id, listed }: {
        id: string;
        listed: boolean;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
    /**
     * Construct and simulate a update_metadata transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     * Update a resource's metadata pointer. Only the creator may call this.
     */
    update_metadata: ({ id, metadata }: {
        id: string;
        metadata: string;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
    /**
     * Construct and simulate a transfer_ownership transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     * Hand ownership to a new creator. Only the current creator may call this.
     */
    transfer_ownership: ({ id, new_creator }: {
        id: string;
        new_creator: string;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
}
export declare class Client extends ContractClient {
    readonly options: ContractClientOptions;
    static deploy<T = Client>(
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions & Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
    }): Promise<AssembledTransaction<T>>;
    constructor(options: ContractClientOptions);
    readonly fromJSON: {
        get: (json: string) => AssembledTransaction<Result<Resource, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        list: (json: string) => AssembledTransaction<Resource[]>;
        count: (json: string) => AssembledTransaction<number>;
        delist: (json: string) => AssembledTransaction<Result<void, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        exists: (json: string) => AssembledTransaction<boolean>;
        register: (json: string) => AssembledTransaction<Result<void, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        set_tags: (json: string) => AssembledTransaction<Result<void, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        get_owner: (json: string) => AssembledTransaction<Result<string, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        set_price: (json: string) => AssembledTransaction<Result<void, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        set_listed: (json: string) => AssembledTransaction<Result<void, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        update_metadata: (json: string) => AssembledTransaction<Result<void, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        transfer_ownership: (json: string) => AssembledTransaction<Result<void, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
    };
}
//# sourceMappingURL=index.d.ts.map