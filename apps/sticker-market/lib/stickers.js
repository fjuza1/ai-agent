import catalog from "../../../data/stickers_catalog.json";
import legacyCatalog from "../../../data/legacy_stickers_catalog.json";

export const stickers = catalog;
export function stickerById(id, originalName) {
  return legacyCatalog.find((item) => item.id === id && item.name === originalName) || stickers.find((item) => item.id === id);
}
