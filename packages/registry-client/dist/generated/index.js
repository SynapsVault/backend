import { Buffer } from "buffer";
import { Client as ContractClient, Spec as ContractSpec, } from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";
if (typeof window !== "undefined") {
    //@ts-ignore Buffer exists
    window.Buffer = window.Buffer || Buffer;
}
export const Errors = {
    1: { message: "AlreadyRegistered" },
    2: { message: "NotFound" },
    3: { message: "InvalidPrice" },
    4: { message: "MetadataTooLong" },
    5: { message: "InvalidTag" },
};
export class Client extends ContractClient {
    options;
    static async deploy(
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options) {
        return ContractClient.deploy(null, options);
    }
    constructor(options) {
        super(new ContractSpec([
            "AAAAAAAAAD5GZXRjaCBhIHJlc291cmNlLiBFcnJvcnMgd2l0aCBgTm90Rm91bmRgIGlmIGl0IGRvZXMgbm90IGV4aXN0LgAAAAAAA2dldAAAAAABAAAAAAAAAAJpZAAAAAAAEAAAAAEAAAPpAAAH0AAAAAhSZXNvdXJjZQAAAAM=",
            "AAAAAAAAAERQYWdpbmF0ZWQgcmVzb3VyY2UgbGlzdCBpbiBpbnNlcnRpb24gb3JkZXIuIGBsaW1pdGAgaXMgY2FwcGVkIGF0IDIwLgAAAARsaXN0AAAAAgAAAAAAAAAFc3RhcnQAAAAAAAAEAAAAAAAAAAVsaW1pdAAAAAAAAAQAAAABAAAD6gAAB9AAAAAIUmVzb3VyY2U=",
            "AAAAAAAAAFtUb3RhbCBudW1iZXIgb2YgcmVzb3VyY2VzIHN1Y2Nlc3NmdWxseSByZWdpc3RlcmVkIChtb25vdG9uaWM7IG5vdCBkZWNyZW1lbnRlZCBvbiB0cmFuc2ZlcikuAAAAAAVjb3VudAAAAAAAAAAAAAABAAAABA==",
            "AAAAAAAAAF1EZWxpc3QgYSByZXNvdXJjZSAoY29udmVuaWVuY2UgbWV0aG9kIGZvciBzZXRfbGlzdGVkKGZhbHNlKSkuIE9ubHkgdGhlIGNyZWF0b3IgbWF5IGNhbGwgdGhpcy4AAAAAAAAGZGVsaXN0AAAAAAABAAAAAAAAAAJpZAAAAAAAEAAAAAEAAAPpAAAD7QAAAAAAAAAD",
            "AAAAAAAAACtXaGV0aGVyIGEgcmVzb3VyY2Ugd2l0aCBgaWRgIGlzIHJlZ2lzdGVyZWQuAAAAAAZleGlzdHMAAAAAAAEAAAAAAAAAAmlkAAAAAAAQAAAAAQAAAAE=",
            "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAABQAAAAAAAAARQWxyZWFkeVJlZ2lzdGVyZWQAAAAAAAABAAAAAAAAAAhOb3RGb3VuZAAAAAIAAAAAAAAADEludmFsaWRQcmljZQAAAAMAAAAAAAAAD01ldGFkYXRhVG9vTG9uZwAAAAAEAAAAAAAAAApJbnZhbGlkVGFnAAAAAAAF",
            "AAAAAAAAAG1SZWdpc3RlciBhIG5ldyByZXNvdXJjZS4gRXJyb3JzIGlmIGBpZGAgYWxyZWFkeSBleGlzdHMgb3IgYHByaWNlIDw9IDBgLgpSZXF1aXJlcyB0aGUgY3JlYXRvcidzIGF1dGhvcml6YXRpb24uAAAAAAAACHJlZ2lzdGVyAAAABQAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAAAAAAJpZAAAAAAAEAAAAAAAAAAFcHJpY2UAAAAAAAALAAAAAAAAAAhtZXRhZGF0YQAAABAAAAAAAAAABHRhZ3MAAAPqAAAAEAAAAAEAAAPpAAAD7QAAAAAAAAAD",
            "AAAAAAAAAIBSZXBsYWNlIGEgcmVzb3VyY2UncyBkaXNjb3ZlcnkgdGFncy4gT25seSB0aGUgY3JlYXRvciBtYXkgY2FsbCB0aGlzLgpEb2VzIG5vdCBtb2RpZnkgYG1ldGFkYXRhYCAodGhlIG9mZi1jaGFpbiBjb250ZW50IHBvaW50ZXIpLgAAAAhzZXRfdGFncwAAAAIAAAAAAAAAAmlkAAAAAAAQAAAAAAAAAAR0YWdzAAAD6gAAABAAAAABAAAD6QAAA+0AAAAAAAAAAw==",
            "AAAAAAAAAFFHZXQgdGhlIG93bmVyIGFkZHJlc3Mgb2YgYSByZXNvdXJjZS4gRXJyb3JzIHdpdGggYE5vdEZvdW5kYCBpZiBpdCBkb2VzIG5vdCBleGlzdC4AAAAAAAAJZ2V0X293bmVyAAAAAAAAAQAAAAAAAAACaWQAAAAAABAAAAABAAAD6QAAABMAAAAD",
            "AAAAAAAAADpVcGRhdGUgYSByZXNvdXJjZSdzIHByaWNlLiBPbmx5IHRoZSBjcmVhdG9yIG1heSBjYWxsIHRoaXMuAAAAAAAJc2V0X3ByaWNlAAAAAAAAAgAAAAAAAAACaWQAAAAAABAAAAAAAAAACW5ld19wcmljZQAAAAAAAAsAAAABAAAD6QAAA+0AAAAAAAAAAw==",
            "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAAAwAAAAEAAAAAAAAACFJlc291cmNlAAAAAQAAABAAAAAAAAAAAAAAAAVDb3VudAAAAAAAAAEAAAAAAAAABUluZGV4AAAAAAAAAQAAAAQ=",
            "AAAAAAAAAERTZXQgdGhlIGxpc3Rpbmcgc3RhdGUgb2YgYSByZXNvdXJjZS4gT25seSB0aGUgY3JlYXRvciBtYXkgY2FsbCB0aGlzLgAAAApzZXRfbGlzdGVkAAAAAAACAAAAAAAAAAJpZAAAAAAAEAAAAAAAAAAGbGlzdGVkAAAAAAABAAAAAQAAA+kAAAPtAAAAAAAAAAM=",
            "AAAAAQAAAAAAAAAAAAAACFJlc291cmNlAAAABgAAAAAAAAAHY3JlYXRvcgAAAAATAAAAAAAAAAJpZAAAAAAAEAAAAAAAAAAGbGlzdGVkAAAAAAABAAAAAAAAAAhtZXRhZGF0YQAAABAAAAAAAAAABXByaWNlAAAAAAAACwAAAJNEaXNjb3ZlcnkgbGFiZWxzIChlLmcuICJkYXRhc2V0IiwgInJlc2VhcmNoIikuIERpc3RpbmN0IGZyb20gYG1ldGFkYXRhYCwKd2hpY2ggcmVtYWlucyB0aGUgb2ZmLWNoYWluIGNvbnRlbnQgYW5jaG9yIChJUEZTIFVSSSwgY29udGVudCBoYXNoLCBldGMuKS4AAAAABHRhZ3MAAAPqAAAAEA==",
            "AAAAAAAAAEVVcGRhdGUgYSByZXNvdXJjZSdzIG1ldGFkYXRhIHBvaW50ZXIuIE9ubHkgdGhlIGNyZWF0b3IgbWF5IGNhbGwgdGhpcy4AAAAAAAAPdXBkYXRlX21ldGFkYXRhAAAAAAIAAAAAAAAAAmlkAAAAAAAQAAAAAAAAAAhtZXRhZGF0YQAAABAAAAABAAAD6QAAA+0AAAAAAAAAAw==",
            "AAAAAAAAAEhIYW5kIG93bmVyc2hpcCB0byBhIG5ldyBjcmVhdG9yLiBPbmx5IHRoZSBjdXJyZW50IGNyZWF0b3IgbWF5IGNhbGwgdGhpcy4AAAASdHJhbnNmZXJfb3duZXJzaGlwAAAAAAACAAAAAAAAAAJpZAAAAAAAEAAAAAAAAAALbmV3X2NyZWF0b3IAAAAAEwAAAAEAAAPpAAAD7QAAAAAAAAAD",
        ]), options);
        this.options = options;
    }
    fromJSON = {
        get: (this.txFromJSON),
        list: (this.txFromJSON),
        count: (this.txFromJSON),
        delist: (this.txFromJSON),
        exists: (this.txFromJSON),
        register: (this.txFromJSON),
        set_tags: (this.txFromJSON),
        get_owner: (this.txFromJSON),
        set_price: (this.txFromJSON),
        set_listed: (this.txFromJSON),
        update_metadata: (this.txFromJSON),
        transfer_ownership: (this.txFromJSON),
    };
}
//# sourceMappingURL=index.js.map