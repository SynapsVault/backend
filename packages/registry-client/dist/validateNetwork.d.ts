import { type StellarDeploymentNetwork } from "./networks.js";
/** x402 network strings accepted by SynapsVault. */
export declare const X402_NETWORK_IDS: {
    readonly testnet: "stellar:testnet";
    readonly mainnet: "stellar:pubnet";
};
export interface NetworkConfigInput {
    stellarNetwork: StellarDeploymentNetwork;
    x402Network: string;
    sorobanRpcUrl: string;
    horizonUrl?: string;
    usdcSacContractId?: string;
    registryContractId?: string;
}
export interface NetworkValidationIssue {
    field: string;
    message: string;
}
/** Normalize x402 network id (accept stellar:mainnet as alias for stellar:pubnet). */
export declare function normalizeX402Network(network: string): string;
/** Infer deployment network from an x402 network string. */
export declare function inferNetworkFromX402(network: string): StellarDeploymentNetwork | undefined;
/** Infer deployment network from a Soroban RPC URL hostname. */
export declare function inferNetworkFromRpcUrl(rpcUrl: string): StellarDeploymentNetwork | undefined;
/** Infer deployment network from a Horizon URL hostname. */
export declare function inferNetworkFromHorizonUrl(horizonUrl: string): StellarDeploymentNetwork | undefined;
/** Stellar network passphrase for the given x402 network id. */
export declare function networkPassphraseForX402(x402Network: string): string;
/**
 * Validate that network-related settings are internally consistent.
 * Returns a list of issues; an empty list means the config is valid.
 */
export declare function validateNetworkConfig(input: NetworkConfigInput): NetworkValidationIssue[];
/** Apply network preset defaults to env vars that were not explicitly set. */
export declare function applyNetworkEnvDefaults(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
//# sourceMappingURL=validateNetwork.d.ts.map