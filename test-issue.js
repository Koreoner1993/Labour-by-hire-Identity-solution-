require("dotenv").config();
const { LBHIdentityService } = require("./identity-service");

async function main() {
  const svc = new LBHIdentityService();

  // ── Step 1: Deploy token (first time only) ──────────────────────────────
  // If LBH_IDENTITY_TOKEN_ID not set, create the token
  if (!process.env.LBH_IDENTITY_TOKEN_ID) {
    console.log("No token ID found — creating identity token...");
    const tokenId = await svc.nft.createIdentityToken();
    console.log(`\n⚠️  Add this to your .env:\nLBH_IDENTITY_TOKEN_ID=${tokenId}\n`);
    process.exit(0);
  }

  // ── Step 2: Issue identity to a test tradie ─────────────────────────────
  const tradie = {
    id: "tradie-001",
    name: "Jake Thornton",
    abn: "51 824 753 556",
    role: "Carpenter",
    labourScore: 72,
  };

  const identity = await svc.issueIdentity(tradie);

  console.log("\n── Identity Record ──────────────────────────────────────────");
  console.log(JSON.stringify(identity, null, 2));

  // ── Step 3: Verify (as an employer would) ──────────────────────────────
  console.log("\n── Employer Verification ────────────────────────────────────");
  const verification = await svc.verifyIdentity(identity.hedera_account_id);
  console.log(JSON.stringify(verification, null, 2));
}

main().catch(console.error);
