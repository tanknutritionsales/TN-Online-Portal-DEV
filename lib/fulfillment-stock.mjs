export function findOfficeShortfalls(officeItems, stockRows) {
  const byVariant = new Map((stockRows || []).map((row) => [row.variantId, row]));
  return (officeItems || []).map((item) => {
    const available = byVariant.get(item.variantId)?.officeAvailable;
    if (!Number.isFinite(available)) throw new Error(`Office stock could not be verified for ${item.productTitle}.`);
    return {
      productTitle: item.productTitle,
      required: Math.max(0, Number(item.quantity || 0)),
      officeAvailable: Math.max(0, available),
    };
  }).filter((item) => item.required > item.officeAvailable);
}
