/**
 * LBH Identity API Routes
 * Mount on your Express app: app.use("/api/identity", identityRouter)
 */

const express = require("express");
const router = express.Router();
const { LBHIdentityService } = require("./identity-service");

// ─── Validation helpers ──────────────────────────────────────────────────────

// Hedera account IDs: shard.realm.num e.g. 0.0.12345
const HEDERA_ACCOUNT_RE = /^\d+\.\d+\.\d+$/;

// Australian Business Number: 11 digits (spaces allowed)
const ABN_RE = /^(\d\s?){10}\d$/;

function isString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function isValidLabourScore(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;
}

// ─── Service singleton ───────────────────────────────────────────────────────

let identity;
function getService() {
  if (!identity) {
    identity = new LBHIdentityService();
  }
  return identity;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * POST /api/identity/issue
 * Issue a decentralised identity to a verified tradie
 *
 * Body: { id, name, abn, role, labourScore }
 */
router.post("/issue", async (req, res) => {
  try {
    const { id, name, abn, role, labourScore = 0 } = req.body;

    if (!isString(id))   return res.status(400).json({ error: "id must be a non-empty string" });
    if (!isString(name)) return res.status(400).json({ error: "name must be a non-empty string" });
    if (!isString(abn))  return res.status(400).json({ error: "abn must be a non-empty string" });
    if (!isString(role)) return res.status(400).json({ error: "role must be a non-empty string" });
    if (!ABN_RE.test(abn.trim())) return res.status(400).json({ error: "abn must be a valid 11-digit Australian Business Number" });
    if (!isValidLabourScore(labourScore)) return res.status(400).json({ error: "labourScore must be a number between 0 and 100" });

    const svc = getService();
    const identityRecord = await svc.issueIdentity({
      id: id.trim(),
      name: name.trim(),
      abn: abn.trim(),
      role: role.trim(),
      labourScore,
    });

    // Strip private key from the API response — caller must store it securely out-of-band
    const { hedera_private_key, ...safeRecord } = identityRecord;

    res.json({ success: true, identity: safeRecord });
  } catch (err) {
    console.error("[LBH] Identity issue error:", err.message);
    res.status(500).json({ error: "Failed to issue identity" });
  }
});

/**
 * GET /api/identity/verify/:accountId
 * Employer-facing verification — no crypto knowledge needed
 *
 * Returns: name, role, labourScore, did, issued_at, verified
 */
router.get("/verify/:accountId", async (req, res) => {
  try {
    const { accountId } = req.params;

    if (!HEDERA_ACCOUNT_RE.test(accountId)) {
      return res.status(400).json({ error: "accountId must be a valid Hedera account (e.g. 0.0.12345)" });
    }

    const svc = getService();
    const result = await svc.verifyIdentity(accountId);
    res.json(result);
  } catch (err) {
    console.error("[LBH] Verify error:", err.message);
    res.status(500).json({ error: "Failed to verify identity" });
  }
});

/**
 * POST /api/identity/score
 * Update Labour Score — called by your scoring engine
 *
 * Body: { identity: <record from DB>, newScore: number }
 */
router.post("/score", async (req, res) => {
  try {
    const { identity: identityRecord, newScore } = req.body;

    if (!identityRecord || typeof identityRecord !== "object") {
      return res.status(400).json({ error: "identity must be an object" });
    }
    if (!isValidLabourScore(newScore)) {
      return res.status(400).json({ error: "newScore must be a number between 0 and 100" });
    }

    const requiredFields = ["tradie_id", "did", "did_topic_id", "hedera_account_id", "hedera_private_key", "name", "abn", "role"];
    const missing = requiredFields.filter((f) => !identityRecord[f]);
    if (missing.length > 0) {
      return res.status(400).json({ error: `identity is missing required fields: ${missing.join(", ")}` });
    }

    const svc = getService();
    const updated = await svc.updateLabourScore(identityRecord, newScore);

    const { hedera_private_key, ...safeRecord } = updated;
    res.json({ success: true, identity: safeRecord });
  } catch (err) {
    console.error("[LBH] Score update error:", err.message);
    res.status(500).json({ error: "Failed to update labour score" });
  }
});

/**
 * GET /api/identity/account/:accountId
 * Display account details — balance, EVM address, key type, metadata
 * Fetches live data from the Hedera mirror node.
 */
router.get("/account/:accountId", async (req, res) => {
  try {
    const { accountId } = req.params;

    if (!HEDERA_ACCOUNT_RE.test(accountId)) {
      return res.status(400).json({ error: "accountId must be a valid Hedera account (e.g. 0.0.12345)" });
    }

    const svc = getService();
    const details = await svc.getAccountDetails(accountId);
    res.json(details);
  } catch (err) {
    console.error("[LBH] Account details error:", err.message);
    res.status(500).json({ error: "Failed to fetch account details" });
  }
});

/**
 * POST /api/identity/setup-token
 * One-time: deploy the LBH Identity HTS token
 * Protect this route with your platform's admin auth middleware before mounting.
 */
router.post("/setup-token", async (req, res) => {
  try {
    const svc = getService();
    const tokenId = await svc.nft.createIdentityToken();

    res.json({
      success: true,
      tokenId,
      message: `Add LBH_IDENTITY_TOKEN_ID=${tokenId} to your environment variables`,
    });
  } catch (err) {
    console.error("[LBH] Token setup error:", err.message);
    res.status(500).json({ error: "Failed to create identity token" });
  }
});

module.exports = router;
