import type { ExtensionContext } from "vscode";
import type { StoredTokens, TokenStore } from "@zalkera/devtools-core";

/**
 * VS Code SecretStorage 기반 토큰 보관소(A2).
 *
 * **파일에 쓰지 않는다.** 워크스페이스 파일에 두면 고객이 그 폴더를 통째로 zip 으로 올리는 순간 우리
 * 자격증명이 서버로 간다 — 이 도구의 주 사용 흐름이 정확히 "폴더를 묶어 올리는 것"이라 더 위험하다.
 */
export class SecretTokenStore implements TokenStore {
    private readonly context: ExtensionContext;
    private readonly key = "zalkera.tokens";

    constructor(context: ExtensionContext) {
        this.context = context;
    }

    async read(): Promise<StoredTokens | null> {
        const raw = await this.context.secrets.get(this.key);
        if (!raw) return null;
        try {
            return JSON.parse(raw) as StoredTokens;
        } catch {
            // 형식이 깨졌으면 없는 것으로 본다 — 깨진 값을 들고 재시도해 봐야 같은 실패만 반복한다.
            await this.clear();
            return null;
        }
    }

    async write(tokens: StoredTokens): Promise<void> {
        await this.context.secrets.store(this.key, JSON.stringify(tokens));
    }

    async clear(): Promise<void> {
        await this.context.secrets.delete(this.key);
    }
}
