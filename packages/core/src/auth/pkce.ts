import { createHash, randomBytes } from "node:crypto";

/**
 * PKCE(RFC 7636). 이 클라이언트는 **public** 이라 시크릿을 숨길 곳이 없다 — 고객 노트북에 깔리는 물건이
 * 시크릿을 갖고 있다고 말하는 순간 그 말이 거짓이 된다. 보호는 시크릿이 아니라 이것이 한다.
 */
export interface Pkce {
    verifier: string;
    challenge: string;
    method: "S256";
}

/** 코드 검증자·챌린지 한 쌍. 검증자는 CSPRNG 43~128자 URL-safe(사양 권고 상단인 96바이트→128자를 쓴다). */
export function createPkce(): Pkce {
    const verifier = base64Url(randomBytes(96));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    return { verifier, challenge, method: "S256" };
}

/** CSRF 방어용 state. 인가 응답이 **내가 시작한 요청**의 답인지 대조한다. */
export function createState(): string {
    return base64Url(randomBytes(32));
}

function base64Url(buffer: Buffer): string {
    return buffer.toString("base64url");
}
