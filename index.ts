import { startTelegramBot } from "./telegram-bot";

console.log("Starting NFT Gift Price Bot...");

startTelegramBot().catch((error) => {
  console.error("Fatal error starting bot:", error);
  process.exit(1);
});
