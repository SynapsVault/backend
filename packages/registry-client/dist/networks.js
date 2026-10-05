import { Networks } from "@stellar/stellar-sdk";
export const networks = {
    testnet: {
        stellarNetwork: "testnet",
        x402Network: "stellar:testnet",
        networkPassphrase: Networks.TESTNET,
        sorobanRpcUrl: "https://soroban-testnet.stellar.org",
        horizonUrl: "https://horizon-testnet.stellar.org",
        explorerNetwork: "testnet",
        usdcSacContractId: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        usdcClassicIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        defaultRegistryContractId: "CDQKUIADLO5S5WEHEUTTXX2M45WAHVRU2PBEBD6ZGDKMOP5A72FJ3OD4",
    },
    mainnet: {
        stellarNetwork: "mainnet",
        x402Network: "stellar:pubnet",
        networkPassphrase: Networks.PUBLIC,
        sorobanRpcUrl: "https://soroban.stellar.org",
        horizonUrl: "https://horizon.stellar.org",
        explorerNetwork: "public",
        usdcSacContractId: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
        usdcClassicIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        defaultRegistryContractId: null,
    },
};
/** Accepted aliases for STELLAR_NETWORK env var. */
const STELLAR_NETWORK_ALIASES = {
    testnet: "testnet",
    mainnet: "mainnet",
    pubnet: "mainnet",
    public: "mainnet",
};
/**
 * Parse STELLAR_NETWORK (or alias) into a deployment network id.
 * Returns undefined when the value is missing or unrecognized.
 */
export function parseStellarNetwork(value) {
    if (!value)
        return undefined;
    return STELLAR_NETWORK_ALIASES[value.trim().toLowerCase()];
}
/** Resolve deployment network, defaulting to testnet. */
export function resolveStellarNetwork(value) {
    return parseStellarNetwork(value) ?? "testnet";
}
/** Look up the preset for a deployment network. */
export function getNetworkPreset(network) {
    return networks[network];
}
//# sourceMappingURL=networks.js.map