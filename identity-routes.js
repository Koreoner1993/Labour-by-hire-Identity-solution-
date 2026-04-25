/**
 * LBH Identity API Routes
 * Mount on your Express app: app.use("/api/identity", identityRouter)
 */

const express = require("express");
const router = express.Router();
const { LBHIdentityService } = require("./identity-service");

// Initialise once — reuse across requests
let identity;
function getService() {
  if (!identity) {
    identity = new LBHIdentityService();
    // If token already deployed, load it
    if (process.env.LBH_IDENTITY_TOKEN_ID) {
      identity.nft.loadToken(process.env.LBH_IDENTITY_TOKEN_ID);
    }
  }
  return identity;
}

/**
 * POST /api/identity/issue
 * Issue a decentralised identity to a verified tradie
 *
 * Body: { id, name, abn, role, labourScore }
 */
router.post("/issue", async (req, res) => {
  try {
    const { id, name, abn, role, labourScore } = req.body;

    if (!id || !name || !abn || !role) {
      return res.status(400).json({ error: "id, name, abn, role are required" });
    }

    const svc = getService();
    const identityRecord = await svc.issueIdentity({
      id,
      name,
      abn,
      role,
      labourScore: labourScore ?? 0,
    });

    // ⚠️ Encrypt hedera_private_key before persisting to your DB
    // identityRecord.hedera_private_key = encrypt(identityRecord.hedera_private_key)

    res.json({ success: true, identity: identityRecord });
  } catch (err) {
    console.error("[LBH] Identity issue error:", err);
    res.status(500).json({ error: err.message });
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
    const svc = getService();
    const result = await svc.verifyIdentity(req.params.accountId);
    res.json(result);
  } catch (err) {
    console.error("[LBH] Verify error:", err);
    res.status(500).json({ error: err.message });
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

    if (!identityRecord || newScore === undefined) {
      return res.status(400).json({ error: "identity and newScore required" });
    }

    const svc = getService();
    const updated = await svc.updateLabourScore(identityRecord, newScore);

    res.json({ success: true, identity: updated });
  } catch (err) {
    console.error("[LBH] Score update error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/identity/setup-token
 * One-time: deploy the LBH Identity HTS token
 * Protect this route — admin only
 */
router.post("/setup-token", async (req, res) => {
  try {
    const svc = getService();
    const tokenId = await svc.nft.createIdentityToken();

    // Save LBH_IDENTITY_TOKEN_ID to your .env / Railway env vars
    res.json({
      success: true,
      tokenId,
      message: `Add LBH_IDENTITY_TOKEN_ID=${tokenId} to your environment variables`,
    });
  } catch (err) {
    console.error("[LBH] Token setup error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
