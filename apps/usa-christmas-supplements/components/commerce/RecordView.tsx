"use client";

import { useEffect } from "react";
import { recordView } from "./shopStore.ts";

export default function RecordView({ productId }: { productId: string }) {
  useEffect(() => { recordView(productId); }, [productId]);
  return null;
}
