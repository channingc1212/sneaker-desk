import { handleEbayAccountDeletion } from "../../server/ebayAccountDeletion.mjs";

export default async function handler(req, res) {
  await handleEbayAccountDeletion(req, res);
}
