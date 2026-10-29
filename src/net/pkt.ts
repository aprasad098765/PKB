// pkt-line framing used by the smart protocol: 4 hex digits of length (including the
// 4 bytes themselves) followed by the payload; "0000" is a flush packet.
// Observed on the wire against git-http-backend (fixtures net-*); side-band-64k data
// arrives as pkt-lines whose first payload byte is the band (1 data, 2 progress, 3 error).

export const FLUSH = Buffer.from("0000");

export function pkt(s: string | Buffer): Buffer {
  const body = typeof s === "string" ? Buffer.from(s, "utf8") : s;
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, "0")), body]);
}

export interface Pkt {
  flush: boolean;
  data: Buffer;
}

export function readPkts(buf: Buffer, start = 0): { pkts: Pkt[]; end: number } {
  const pkts: Pkt[] = [];
  let p = start;
  while (p + 4 <= buf.length) {
    const len = parseInt(buf.toString("latin1", p, p + 4), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      pkts.push({ flush: true, data: Buffer.alloc(0) });
      p += 4;
      continue;
    }
    if (len < 4 || p + len > buf.length) break;
    pkts.push({ flush: false, data: buf.subarray(p + 4, p + len) });
    p += len;
  }
  return { pkts, end: p };
}

export const line = (b: Buffer) => b.toString("utf8").replace(/\n$/, "");
