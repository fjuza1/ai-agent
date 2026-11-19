import { writeFile } from "node:fs/promises";

const client = process.env.ADSENSE_CLIENT_ID || "";
if (!/^ca-pub-\d{16}$/.test(client)) throw new Error("ADSENSE_CLIENT_ID must be ca-pub- followed by 16 digits.");
const content = `google.com, ${client.slice(3)}, DIRECT, f08c47fec0942fa0\n`;
for (const app of ["sticker-market", "usa-christmas-supplements"]) {
  await writeFile(new URL(`../apps/${app}/public/ads.txt`, import.meta.url), content);
  console.log(`Generated ads.txt for ${app}`);
}
