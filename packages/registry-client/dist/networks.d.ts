/** Deployment target: Stellar testnet or mainnet (pubnet). */
export type StellarDeploymentNetwork = "testnet" | "mainnet";
/** Stellar Expert explorer segment for a deployment network. */
export type ExplorerNetwork = "testnet" | "public";
/**
 * Canonical network constants for SynapsVault deployments.
 * Operators select `testnet` or `mainnet` via STELLAR_NETWORK and may override
 * individual fields with env vars.
 */
export interface NetworkPreset {
    stellarNetwork: StellarDeploymentNetwork;
    /** x402 network identifier passed to paywalls and signers. */
    x402Network: string;
    networkPassphrase: string;
    sorobanRpcUrl: string;
    horizonUrl: string;
    explorerNetwork: ExplorerNetwork;
    /** Soroban USDC Stellar Asset Contract (SEP-41) used by x402. */
    usdcSacContractId: string;
    /** Classic USDC issuer for trustline setup scripts. */
    usdcClassicIssuer: string;
    /**
     * Known vault-registry deployment for this network, if any.
     * Mainnet operators deploy their own contract and set VAULT_REGISTRY_CONTRACT_ID.
     */
    defaultRegistryContractId: string | null;
}
export declare const networks: Record<StellarDeploymentNetwork, NetworkPreset>;
/**
 * Parse STELLAR_NETWORK (or alias) into a deployment network id.
 * Returns undefined when the value is missing or unrecognized.
 */
export declare function parseStellarNetwork(value: string | undefined): StellarDeploymentNetwork | undefined;
/** Resolve deployment network, defaulting to testnet. */
export declare function resolveStellarNetwork(value: string | undefined): StellarDeploymentNetwork;
/** Look up the preset for a deployment network. */
export declare function getNetworkPreset(network: StellarDeploymentNetwork): NetworkPreset;
//# sourceMappingURL=networks.d.ts.map