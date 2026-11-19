export default function FdaClearedOtcBadge({ product }) {
  if (!product.fda_cleared_otc) return null;
  return <details className="mt-3 text-sm">
    <summary className="font-bold cursor-pointer">FDA-Cleared OTC Medical Device · {product.fda_device_name}</summary>
    <p className="mt-2">This clearance applies to the named pregnancy test device, not necessarily every item in the bundle. Follow the device instructions and consult a healthcare professional with questions.</p>
    <p>{product.fda_510k_number && <>510(k): {product.fda_510k_number}. </>}<a href={product.fda_clearance_source} rel="noreferrer">View clearance evidence</a></p>
  </details>;
}
