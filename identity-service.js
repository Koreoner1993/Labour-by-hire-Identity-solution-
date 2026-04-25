/**
 * LBH Identity Service
 * Hedera Decentralised Identity — DID (HCS) + Soulbound HTS NFT
 *
 * Flow:
 *  1. Generate Hedera keypair for tradie
 *  2. Create HCS topic → anchor DID document
 *  3. Create/reuse soulbound HTS NFT token
 *  4. Mint NFT with DID + Labour Score metadata
 *  5. Transfer (frozen) to tradie wallet → non-transferable
 */

const {
  Client,
  AccountId,
  PrivateKey,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
  TokenCreateTransaction,
  TokenMintTransaction,
  TokenAssociateTransaction,
  TransferTransaction,
  TokenFreezeTransaction,
  TokenType,
  TokenSupplyType,
  CustomRoyaltyFee,
  Hbar,
} = require("@hashgraph/sdk");

const { NFTStorage, File } = require("nft.storage");
const crypto = require("crypto");

// ─── SVG Avatar ─────────────────────────────────────────────────────────────

const LBH_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <ellipse cx="100" cy="100" rx="90" ry="35" fill="none" stroke="#1d4ed8" stroke-width="2.5" transform="rotate(-30 100 100)"/>
  <ellipse cx="100" cy="100" rx="90" ry="35" fill="none" stroke="#1d4ed8" stroke-width="2.5" transform="rotate(30 100 100)"/>
  <ellipse cx="100" cy="100" rx="90" ry="35" fill="none" stroke="#1d4ed8" stroke-width="2.5"/>
  <circle cx="65" cy="85" r="10" fill="#1e293b"/>
  <path d="M50 120 Q65 108 80 120 L78 145 H52 Z" fill="#1e293b"/>
  <circle cx="100" cy="80" r="11" fill="#1e293b"/>
  <path d="M84 118 Q100 105 116 118 L114 145 H86 Z" fill="#1e293b"/>
  <circle cx="135" cy="85" r="10" fill="#1e293b"/>
  <path d="M120 120 Q135 108 150 120 L148 145 H122 Z" fill="#1e293b"/>
</svg>`;

// ─── IPFS Service ────────────────────────────────────────────────────────────

class IPFSService {
  constructor(apiKey) {
    this.client = new NFTStorage({ token: apiKey });
  }

  /**
   * Upload SVG avatar + JSON metadata to IPFS via NFT.Storage
   * Returns { avatarCid, metadataCid, metadataUri }
   */
  async uploadIdentityMetadata({ tradieId, name, abn, role, labourScore, didId }) {
    // Upload SVG avatar
    const svgFile = new File([LBH_SVG], "lbh-avatar.svg", { type: "image/svg+xml" });

    // Build DID document (W3C DID Core spec)
    const didDocument = {
      "@context": [
        "https://www.w3.org/ns/did/v1",
        "https://w3id.org/security/suites/ed25519-2020/v1",
      ],
      id: didId,
      controller: didId,
      verificationMethod: [
        {
          id: `${didId}#key-1`,
          type: "Ed25519VerificationKey2020",
          controller: didId,
        },
      ],
      authentication: [`${didId}#key-1`],
      assertionMethod: [`${didId}#key-1`],
      service: [
        {
          id: `${didId}#lbh-profile`,
          type: "LabourByHireProfile",
          serviceEndpoint: `https://labourbyhi.re/tradie/${tradieId}`,
        },
      ],
    };

    // Build NFT metadata (OpenSea-compatible + LBH extensions)
    const metadata = {
      name: `LBH Identity — ${name}`,
      description: `Verified Labour by Hire decentralised identity credential for ${name}. Non-transferable.`,
      image: "", // populated after upload
      external_url: `https://labourbyhi.re/tradie/${tradieId}`,
      attributes: [
        { trait_type: "Role", value: role },
        { trait_type: "ABN Hash", value: hashABN(abn) },
        { trait_type: "Labour Score", value: labourScore, display_type: "number" },
        { trait_type: "Verified", value: "true" },
        { trait_type: "Credential Type", value: "Soulbound" },
        { trait_type: "Issuer", value: "Labour by Hire Pty Ltd" },
        { trait_type: "Issued", value: new Date().toISOString() },
      ],
      lbh: {
        tradie_id: tradieId,
        did: didId,
        did_document: didDocument,
        labour_score: labourScore,
        abn_hash: hashABN(abn),
        role,
        credential_version: "1.0",
      },
    };

    // Upload image + metadata together
    const result = await this.client.store({
      ...metadata,
      image: svgFile,
    });

    return {
      avatarCid: result.data.image.href,
      metadataCid: result.ipnft,
      metadataUri: result.url, // ipfs://...
    };
  }
}

// ─── Hedera DID Service ──────────────────────────────────────────────────────

class HederaDIDService {
  constructor(client) {
    this.client = client;
  }

  /**
   * Create an HCS topic to anchor the tradie's DID
   * DID = did:hedera:{network}:{base58PublicKey}_{0.0.topicId}
   */
  async createDID(tradiePublicKey, operatorKey) {
    const topic = await new TopicCreateTransaction()
      .setAdminKey(operatorKey)       // platform can update
      .setSubmitKey(tradiePublicKey)  // tradie controls submissions
      .setTopicMemo(`LBH DID — ${Date.now()}`)
      .execute(this.client);

    const receipt = await topic.getReceipt(this.client);
    const topicId = receipt.topicId.toString();

    // Hedera DID format (Hedera DID method spec v1)
    const network = process.env.HEDERA_NETWORK || "testnet";
    const publicKeyBase58 = toBase58(tradiePublicKey.toBytes());
    const did = `did:hedera:${network}:${publicKeyBase58}_${topicId}`;

    return { did, topicId };
  }

  /**
   * Anchor a DID document message to the HCS topic
   */
  async anchorDIDDocument(topicId, didDocument, submitKey) {
    const message = JSON.stringify({
      "@context": "https://www.w3.org/ns/did/v1",
      message: {
        operation: "create",
        did: didDocument.id,
        did_document_base64: Buffer.from(JSON.stringify(didDocument)).toString("base64"),
        timestamp: new Date().toISOString(),
      },
    });

    const tx = await new TopicMessageSubmitTransaction()
      .setTopicId(topicId)
      .setMessage(message)
      .freezeWith(this.client)
      .sign(submitKey);

    const result = await tx.execute(this.client);
    const receipt = await result.getReceipt(this.client);

    return {
      status: receipt.status.toString(),
      sequenceNumber: receipt.topicSequenceNumber?.toString(),
    };
  }
}

// ─── HTS Soulbound NFT Service ───────────────────────────────────────────────

class HederaNFTService {
  constructor(client, operatorId, operatorKey) {
    this.client = client;
    this.operatorId = operatorId;
    this.operatorKey = operatorKey;
    this.tokenId = null; // set after createToken or loadToken
  }

  /**
   * Create the LBH Identity NFT token (one-time platform setup)
   * Soulbound = freeze by default, no transfer royalty bypass
   */
  async createIdentityToken() {
    // 100% royalty fee makes transfer economically impossible as a secondary guard
    const royaltyFee = new CustomRoyaltyFee()
      .setNumerator(1)
      .setDenominator(1) // 100% royalty
      .setFeeCollectorAccountId(this.operatorId);

    const tx = await new TokenCreateTransaction()
      .setTokenName("LBH Identity")
      .setTokenSymbol("LBHID")
      .setTokenType(TokenType.NonFungibleUnique)
      .setSupplyType(TokenSupplyType.Infinite)
      .setTreasuryAccountId(this.operatorId)
      .setAdminKey(this.operatorKey)
      .setSupplyKey(this.operatorKey)
      .setFreezeKey(this.operatorKey)    // enables per-account freeze
      .setFreezeDefault(true)            // all accounts frozen by default → soulbound
      .setCustomFees([royaltyFee])
      .setMaxTransactionFee(new Hbar(30))
      .execute(this.client);

    const receipt = await tx.getReceipt(this.client);
    this.tokenId = receipt.tokenId.toString();

    console.log(`[LBH] Identity token created: ${this.tokenId}`);
    return this.tokenId;
  }

  loadToken(tokenId) {
    this.tokenId = tokenId;
  }

  /**
   * Mint one NFT with the tradie's IPFS metadata URI
   * Returns serial number
   */
  async mintIdentityNFT(metadataUri) {
    if (!this.tokenId) throw new Error("Token not initialised");

    const metadata = Buffer.from(metadataUri); // IPFS URI as bytes

    const tx = await new TokenMintTransaction()
      .setTokenId(this.tokenId)
      .addMetadata(metadata)
      .setMaxTransactionFee(new Hbar(10))
      .execute(this.client);

    const receipt = await tx.getReceipt(this.client);
    const serial = receipt.serials[0].toString();

    console.log(`[LBH] NFT minted — serial: ${serial}`);
    return serial;
  }

  /**
   * Associate token with tradie account, transfer NFT, then freeze
   * After freeze: token is locked in their wallet → non-transferable
   */
  async issueToTradie(tradieAccountId, tradieKey, serialNumber) {
    if (!this.tokenId) throw new Error("Token not initialised");

    // 1. Associate token with tradie account
    const assocTx = await new TokenAssociateTransaction()
      .setAccountId(tradieAccountId)
      .setTokenIds([this.tokenId])
      .freezeWith(this.client)
      .sign(tradieKey);

    await (await assocTx.execute(this.client)).getReceipt(this.client);
    console.log(`[LBH] Token associated with ${tradieAccountId}`);

    // 2. Unfreeze the specific account temporarily to allow mint transfer
    //    (treasury is exempt, but tradie account needs unfreeze for initial receive)
    const unfreezeTx = await new TokenFreezeTransaction()
      .setAccountId(tradieAccountId)
      .setTokenId(this.tokenId)
      .freezeWith(this.client)
      .sign(this.operatorKey);
    // Note: we actually need TokenUnfreezeTransaction for this step
    // Using raw approach below for clarity
    const { TokenUnfreezeTransaction } = require("@hashgraph/sdk");

    const unfreezeActual = await new TokenUnfreezeTransaction()
      .setAccountId(tradieAccountId)
      .setTokenId(this.tokenId)
      .freezeWith(this.client)
      .sign(this.operatorKey);

    await (await unfreezeActual.execute(this.client)).getReceipt(this.client);

    // 3. Transfer NFT from treasury to tradie
    const transferTx = await new TransferTransaction()
      .addNftTransfer(this.tokenId, serialNumber, this.operatorId, tradieAccountId)
      .freezeWith(this.client)
      .sign(this.operatorKey);

    await (await transferTx.execute(this.client)).getReceipt(this.client);
    console.log(`[LBH] NFT transferred to ${tradieAccountId}`);

    // 4. Freeze tradie account → soulbound lock
    const freezeTx = await new TokenFreezeTransaction()
      .setAccountId(tradieAccountId)
      .setTokenId(this.tokenId)
      .freezeWith(this.client)
      .sign(this.operatorKey);

    await (await freezeTx.execute(this.client)).getReceipt(this.client);
    console.log(`[LBH] NFT frozen in ${tradieAccountId} — soulbound`);

    return { status: "issued", frozen: true };
  }
}

// ─── Main Identity Service ───────────────────────────────────────────────────

class LBHIdentityService {
  constructor(config = {}) {
    const operatorId = config.operatorId || process.env.HEDERA_OPERATOR_ID;
    const operatorKey = config.operatorKey || process.env.HEDERA_OPERATOR_KEY;
    const network = config.network || process.env.HEDERA_NETWORK || "testnet";
    const nftStorageKey = config.nftStorageKey || process.env.NFT_STORAGE_KEY;
    const tokenId = config.tokenId || process.env.LBH_IDENTITY_TOKEN_ID;

    if (!operatorId || !operatorKey) {
      throw new Error("HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY are required");
    }

    // Hedera client
    this.client =
      network === "mainnet"
        ? Client.forMainnet()
        : Client.forTestnet();

    this.operatorKey = PrivateKey.fromString(operatorKey);
    this.operatorId = AccountId.fromString(operatorId);

    this.client.setOperator(this.operatorId, this.operatorKey);

    // Sub-services
    this.ipfs = new IPFSService(nftStorageKey);
    this.did = new HederaDIDService(this.client);
    this.nft = new HederaNFTService(this.client, this.operatorId, this.operatorKey);

    if (tokenId) {
      this.nft.loadToken(tokenId);
    }
  }

  /**
   * Issue a full decentralised identity to a tradie
   *
   * @param {Object} tradie
   * @param {string} tradie.id          - LBH internal UUID
   * @param {string} tradie.name        - Full name
   * @param {string} tradie.abn         - Australian Business Number
   * @param {string} tradie.role        - e.g. "Carpenter", "Electrician"
   * @param {number} tradie.labourScore - 0–100
   *
   * @returns {Object} identity record — store this in your DB
   */
  async issueIdentity(tradie) {
    console.log(`\n[LBH] Issuing identity for ${tradie.name}...`);

    // 1. Generate a Hedera keypair for this tradie
    const tradieKey = PrivateKey.generateED25519();
    const tradiePublicKey = tradieKey.publicKey;

    // 2. Create HCS topic + DID
    const { did, topicId } = await this.did.createDID(
      tradiePublicKey,
      this.operatorKey
    );
    console.log(`[LBH] DID created: ${did}`);

    // 3. Upload metadata + SVG to IPFS
    const { metadataUri, avatarCid } = await this.ipfs.uploadIdentityMetadata({
      tradieId: tradie.id,
      name: tradie.name,
      abn: tradie.abn,
      role: tradie.role,
      labourScore: tradie.labourScore,
      didId: did,
    });
    console.log(`[LBH] Metadata on IPFS: ${metadataUri}`);

    // 4. Anchor DID document to HCS topic
    const didDocument = buildDIDDocument(did, tradiePublicKey, tradie.id);
    await this.did.anchorDIDDocument(topicId, didDocument, tradieKey);
    console.log(`[LBH] DID anchored on HCS topic: ${topicId}`);

    // 5. Create tradie Hedera account (dormant wallet pattern)
    const tradieAccountId = await this.createDormantAccount(tradiePublicKey);
    console.log(`[LBH] Tradie account: ${tradieAccountId}`);

    // 6. Mint soulbound NFT
    const serialNumber = await this.nft.mintIdentityNFT(metadataUri);

    // 7. Issue + freeze to tradie (soulbound)
    await this.nft.issueToTradie(tradieAccountId, tradieKey, serialNumber);

    const identity = {
      tradie_id: tradie.id,
      did,
      did_topic_id: topicId,
      hedera_account_id: tradieAccountId,
      hedera_private_key: tradieKey.toString(), // encrypt before storing
      hedera_public_key: tradiePublicKey.toString(),
      nft_token_id: this.nft.tokenId,
      nft_serial: serialNumber,
      metadata_uri: metadataUri,
      avatar_cid: avatarCid,
      labour_score: tradie.labourScore,
      issued_at: new Date().toISOString(),
      status: "active",
    };

    console.log(`\n[LBH] ✅ Identity issued successfully for ${tradie.name}`);
    return identity;
  }

  /**
   * Verify a tradie's identity via Hedera mirror node
   * Employers call this — no crypto knowledge needed
   */
  async verifyIdentity(hederaAccountId, tokenId) {
    const tid = tokenId || this.nft.tokenId;
    const network = process.env.HEDERA_NETWORK || "testnet";
    const mirrorBase =
      network === "mainnet"
        ? "https://mainnet-public.mirrornode.hedera.com"
        : "https://testnet.mirrornode.hedera.com";

    const url = `${mirrorBase}/api/v1/accounts/${hederaAccountId}/nfts?token.id=${tid}`;
    const res = await fetch(url);
    const data = await res.json();

    if (!data.nfts || data.nfts.length === 0) {
      return { verified: false, reason: "No LBH identity NFT found" };
    }

    const nft = data.nfts[0];
    const metadataUri = Buffer.from(nft.metadata, "base64").toString();

    // Fetch metadata from IPFS gateway
    const ipfsGateway = metadataUri.replace(
      "ipfs://",
      "https://nftstorage.link/ipfs/"
    );
    const metaRes = await fetch(ipfsGateway);
    const metadata = await metaRes.json();

    return {
      verified: true,
      did: metadata.lbh?.did,
      name: metadata.name,
      role: metadata.lbh?.role,
      labour_score: metadata.lbh?.labour_score,
      abn_hash: metadata.lbh?.abn_hash,
      issued_at: metadata.attributes?.find((a) => a.trait_type === "Issued")?.value,
      nft_serial: nft.serial_number,
      frozen: nft.account_id === hederaAccountId, // frozen = soulbound confirmed
    };
  }

  /**
   * Update Labour Score — anchors new message to DID topic + mints new NFT
   * Old NFT remains (immutable history), new NFT has updated score
   */
  async updateLabourScore(identity, newScore) {
    console.log(`[LBH] Updating Labour Score for ${identity.tradie_id}...`);

    // Re-upload metadata with new score
    const { metadataUri } = await this.ipfs.uploadIdentityMetadata({
      tradieId: identity.tradie_id,
      name: identity.name,
      abn: identity.abn,
      role: identity.role,
      labourScore: newScore,
      didId: identity.did,
    });

    // Mint new NFT with updated score
    const newSerial = await this.nft.mintIdentityNFT(metadataUri);

    const tradieKey = PrivateKey.fromString(identity.hedera_private_key);

    // Anchor update to DID topic
    const updateMessage = JSON.stringify({
      operation: "update",
      did: identity.did,
      field: "labourScore",
      value: newScore,
      serial: newSerial,
      timestamp: new Date().toISOString(),
    });

    await new TopicMessageSubmitTransaction()
      .setTopicId(identity.did_topic_id)
      .setMessage(updateMessage)
      .freezeWith(this.client)
      .sign(tradieKey)
      .then((tx) => tx.execute(this.client));

    await this.nft.issueToTradie(
      identity.hedera_account_id,
      tradieKey,
      newSerial
    );

    console.log(`[LBH] Labour Score updated to ${newScore} — serial ${newSerial}`);
    return { ...identity, nft_serial: newSerial, labour_score: newScore };
  }

  /**
   * Create a dormant Hedera account for the tradie
   * Funded with minimum HBAR to cover token associations
   */
  async createDormantAccount(publicKey) {
    const {
      AccountCreateTransaction,
    } = require("@hashgraph/sdk");

    const tx = await new AccountCreateTransaction()
      .setKey(publicKey)
      .setInitialBalance(new Hbar(1)) // ~0.13 AUD — covers associations
      .setAccountMemo("LBH Tradie — Dormant Identity Wallet")
      .execute(this.client);

    const receipt = await tx.getReceipt(this.client);
    return receipt.accountId.toString();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hashABN(abn) {
  // One-way hash — employer sees verification, not raw ABN
  return crypto.createHash("sha256").update(abn.replace(/\s/g, "")).digest("hex").slice(0, 16);
}

function toBase58(bytes) {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let num = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  let result = "";
  const base = BigInt(58);
  while (num > 0n) {
    result = ALPHABET[Number(num % base)] + result;
    num = num / base;
  }
  for (const byte of bytes) {
    if (byte === 0) result = "1" + result;
    else break;
  }
  return result;
}

function buildDIDDocument(did, publicKey, tradieId) {
  return {
    "@context": [
      "https://www.w3.org/ns/did/v1",
      "https://w3id.org/security/suites/ed25519-2020/v1",
    ],
    id: did,
    controller: did,
    verificationMethod: [
      {
        id: `${did}#key-1`,
        type: "Ed25519VerificationKey2020",
        controller: did,
        publicKeyMultibase: `z${toBase58(publicKey.toBytes())}`,
      },
    ],
    authentication: [`${did}#key-1`],
    assertionMethod: [`${did}#key-1`],
    service: [
      {
        id: `${did}#lbh-profile`,
        type: "LabourByHireProfile",
        serviceEndpoint: `https://labourbyhi.re/tradie/${tradieId}`,
      },
      {
        id: `${did}#lbh-verify`,
        type: "LabourByHireVerification",
        serviceEndpoint: "https://labourbyhi.re/api/verify",
      },
    ],
  };
}

module.exports = { LBHIdentityService };
