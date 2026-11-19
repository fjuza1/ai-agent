"use client";
import { useEffect } from "react";

export default function HourlyRefresh() {
  useEffect(() => {
    const delay = 3600000 - Date.now() % 3600000 + 100;
    const timer = setTimeout(() => location.reload(), delay);
    return () => clearTimeout(timer);
  }, []);
  return null;
}
