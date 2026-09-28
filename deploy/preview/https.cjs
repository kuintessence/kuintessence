const fs = require("node:fs");

async function verifyHttps(origin, password, cookie, request = fetch) {
  const options = () => ({ redirect: "manual", signal: AbortSignal.timeout(15000) });
  const anonymous = await request(origin, options());
  if (anonymous.status !== 302 || anonymous.headers.get("location") !== "/__preview/unlock") {
    throw new Error("Anonymous preview requests must be gated");
  }
  const challenge = await request(`${origin}/__preview/unlock`, options());
  if (challenge.status !== 401) throw new Error("Preview unlock must require authentication");
  const unlock = await request(`${origin}/__preview/unlock`, {
    ...options(), headers: { Authorization: `Basic ${Buffer.from(`preview:${password}`).toString("base64")}` },
  });
  if (unlock.status !== 200 || !unlock.headers.get("set-cookie")?.includes(`kq_preview=${cookie};`)) {
    throw new Error("Preview unlock did not issue its secure cookie");
  }
  const headers = { Cookie: `kq_preview=${cookie}` };
  const home = await request(origin, { ...options(), headers });
  if (home.status !== 200 || !home.headers.get("content-type")?.includes("text/html")) {
    throw new Error("Preview Web is unavailable");
  }
  const health = await request(`${origin}/api/health`, { ...options(), headers });
  if (health.status !== 200) throw new Error("Preview Server is unavailable");
}

if (require.main === module) {
  Promise.resolve().then(async () => {
    if (!/^[1-9][0-9]{0,14}$/.test(process.env.PREVIEW_PR ?? "")) throw new Error("Invalid PR");
    const secret = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const decode = (key) => Buffer.from(secret.data[key], "base64").toString("utf8");
    const origin = `https://pr-${process.env.PREVIEW_PR}.preview.dev.kuintessence.com`;
    let ready = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        await verifyHttps(origin, decode("PREVIEW_PASSWORD"), decode("PREVIEW_COOKIE"));
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
    if (!ready) throw new Error("Preview HTTPS acceptance failed");
  }).catch(() => {
    console.error("Preview HTTPS verification failed: check DNS, Traefik TLS and the protected Web/API routes.");
    process.exitCode = 1;
  });
}

module.exports = { verifyHttps };
