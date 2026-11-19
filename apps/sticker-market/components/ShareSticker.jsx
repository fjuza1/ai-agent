"use client";
import { useState } from "react";

export default function ShareSticker({ image, name }) {
  const [message, setMessage] = useState("");
  async function share() {
    try {
      const response = await fetch(image);
      if (!response.ok) throw new Error("Could not load the PNG.");
      const file = new File([await response.blob()], `${name.replace(/[^a-z0-9-]+/gi, "-").toLowerCase()}.png`, { type: "image/png" });
      if (!navigator.share || !navigator.canShare?.({ files: [file] })) {
        setMessage("File sharing is not available here. Use the download link instead.");
        return;
      }
      await navigator.share({ files: [file], title: name });
    } catch (error) {
      if (error?.name !== "AbortError") setMessage("Sharing failed. Use the download link instead.");
    }
  }
  return <div className="flex flex-wrap gap-3 mt-6"><button type="button" onClick={share}>Share PNG to mobile</button><a className="button" href={image} download>Save PNG to phone</a>{message && <p role="status">{message}</p>}</div>;
}
