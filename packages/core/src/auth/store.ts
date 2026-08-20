/**
 * 토큰 보관소 — **코어는 저장하지 않고 위임한다.**
 *
 * 확장은 VS Code SecretStorage 를, CLI 는 OS 키체인이나 사용자 선택 보관소를 꽂는다. 코어가 파일로
 * 직접 쓰기 시작하면 "비밀은 파일에 두지 않는다"는 약속이 코어 안에서 먼저 깨진다.
 */
export interface TokenStore {
    read(): Promise<StoredTokens | null>;
    write(tokens: StoredTokens): Promise<void>;
    clear(): Promise<void>;
}

export interface StoredTokens {
    /** 짧다(현행 정책 2분). 항상 만료 직전으로 가정하고 쓴다. */
    accessToken: string;
    /** 갱신 축. 이것이 없으면 미리보기 한 세션도 못 넘긴다. */
    refreshToken: string;
    /** access 만료 시각(epoch ms). 서버 시계와 다를 수 있어 여유를 두고 갱신한다. */
    expiresAt: number;
    /** 이 토큰이 어느 발급자에서 왔는지 — 서버 주소가 바뀌면 남은 토큰은 쓰레기다. */
    issuer: string;
}

/** 테스트·일회성 실행용. 프로세스가 죽으면 사라진다. */
export class MemoryTokenStore implements TokenStore {
    private tokens: StoredTokens | null = null;

    read(): Promise<StoredTokens | null> {
        return Promise.resolve(this.tokens);
    }

    write(tokens: StoredTokens): Promise<void> {
        this.tokens = tokens;
        return Promise.resolve();
    }

    clear(): Promise<void> {
        this.tokens = null;
        return Promise.resolve();
    }
}
