/** +16029150339 -> +1 (602) 915-0339. Anything else is shown as given. */
export const formatNumber = (e164: string) => {
  const d = e164.replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}` : e164;
};
