export const maxProofBytes = 4000000;
export function proofContentType(buffer) {
  if (buffer.subarray(0,5).toString("ascii") === "%PDF-") return "application/pdf";
  if (buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (buffer.length >= 3 && buffer[0]===255 && buffer[1]===216 && buffer[2]===255) return "image/jpeg";
  if (buffer.length >= 12 && buffer.subarray(0,4).toString("ascii")==="RIFF" && buffer.subarray(8,12).toString("ascii")==="WEBP") return "image/webp";
  return null;
}
export function parsePaymentProof(input) {
  const invalid = () => Object.assign(new Error("Upload a PDF, JPG, PNG or WebP proof of payment."), {status:400});
  const match = typeof input === "string" && /^data:(application\/pdf|image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(input);
  if (!match) throw invalid();
  if (match[2].length > Math.ceil(maxProofBytes/3)*4) throw Object.assign(new Error("Proof of payment must be 4 MB or smaller."),{status:413});
  const buffer=Buffer.from(match[2],"base64");
  if (buffer.length>maxProofBytes) throw Object.assign(new Error("Proof of payment must be 4 MB or smaller."),{status:413});
  if (!buffer.length || buffer.toString("base64").replace(/=+$/,"")!==match[2].replace(/=+$/,"") || proofContentType(buffer)!==match[1]) throw invalid();
  return {contentType:match[1],buffer};
}
