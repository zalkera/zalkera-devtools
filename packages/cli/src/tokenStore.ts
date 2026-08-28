/**
 * **CLI 의 토큰 보관소 — 홈 밖에 두지 않는다.**
 *
 * ## 이것은 vsix 와 동급이 아니다 — 엄밀히 약하다
 *
 * 확장은 OS 키체인(VS Code SecretStorage)을 쓴다. 이쪽은 **평문 파일 0600** 이다. 그리고 여기 담기는
 * 것은 `offline_access` refresh 토큰이라 보관의 반경이 액세스 토큰보다 크다 — 탈취되면 그 사이트의
 * 라이브 발행·전체 소스 반출·파트너 API 전반이 열린다.
 *
 * ⚠ **평문 0600 을 「정석」이라 부르지 않는다 — 관행이다.** `gh` 는 OS 키링이 기본이고 평문은
 *   폴백이다. aws·npm·gcloud 가 평문인 것은 사실이나 그것은 관행이지 지향점이 아니다. 지향점은
 *   키링 우선·평문 폴백이고, 그 자리는 아직 비어 있다.
 *
 * ⇒ **배송 문서가 이 사실을 적는다**: 「이 도구는 로그인 정보를 컴퓨터의 파일에 둡니다. 그 컴퓨터를
 *   쓸 수 있는 사람은 이 사이트를 고치고 배포할 수 있습니다.」
 *
 * ## 왜 코어가 아니라 여기 사는가
 *
 * 코어의 [TokenStore] KDoc 이 「코어가 파일로 직접 쓰기 시작하면 *비밀은 파일에 두지 않는다* 는
 * 약속이 코어 안에서 먼저 깨진다」고 못박았다. 그 약속을 지키려면 파일을 쓰는 쪽이 **바깥**이어야 한다.
 *
 * ## 프로젝트 폴더 금지
 *
 * 🔴 소스 폴더는 **zip 으로 포장돼 유통되는 경로**다(`packProject`). 거기 토큰을 두면 「내 사이트
 *    소스 보내 주세요」 한 번으로 발행 권한이 통째로 넘어간다. 그래서 자리는 홈 아래로 고정하고,
 *    호출부가 자리를 정하게 두지 않는다.
 */
import {chmod, readFile, rm} from "node:fs/promises";
import {homedir} from "node:os";
import {basename, dirname, isAbsolute, join, resolve, sep} from "node:path";
import {ensureOwnDir, tokenPath, writeOwnFile, type StoredTokens, type TokenStore} from "@zalkera/devtools-core";

// ⚠ **자리 계산은 코어 한 벌이다** — 확장도 같은 자리를 물어야 하고, 두 벌이면 갈린다.
export {tokenPath};

/** 평문 0600 파일 보관소. */
export class FileTokenStore implements TokenStore {
    // ⚠ 매개변수 프로퍼티(`constructor(private path)`)를 안 쓴다 — Node 의 타입 제거 실행기가
    //   그 문법을 거절해 **시험이 아예 안 돈다.** 이 레포의 시험은 전부 그 실행기로 돈다.
    private readonly path: string;

    constructor(path: string = tokenPath()) {
        this.path = path;
    }

    async read(): Promise<StoredTokens | null> {
        const text = await readFile(this.path, "utf8").catch(() => null);
        if (text === null) return null;
        try {
            const raw: unknown = JSON.parse(text);
            if (typeof raw !== "object" || raw === null) return null;
            const t = raw as Record<string, unknown>;
            if (
                typeof t.accessToken !== "string" ||
                typeof t.refreshToken !== "string" ||
                typeof t.expiresAt !== "number" ||
                typeof t.issuer !== "string"
            ) {
                // 반쯤 읽지 않는다 — 모자란 토큰으로 부르면 401 이 「로그인하세요」가 아니라
                // 「권한이 없습니다」로 보이고, 사람은 엉뚱한 데서 원인을 찾는다.
                return null;
            }
            return {
                accessToken: t.accessToken,
                refreshToken: t.refreshToken,
                expiresAt: t.expiresAt,
                issuer: t.issuer,
            };
        } catch {
            return null;
        }
    }

    async write(tokens: StoredTokens): Promise<void> {
        // ⚠ **조각마다 링크를 본다.** `mkdir(recursive)` 는 이미 있으면 무동작이고 「이미 있다」에
        //   심링크가 포함된다 — 그러면 토큰이 그 링크가 가리키는 폴더에 씌고 우리는 성공을 보고한다
        //   (심의 실측). 그리고 쓰기는 `rename` 경계를 지난다: 잎이 **하드링크**면 `lstat` 는 못 보고
        //   맨 `writeFile` 은 대상에 그대로 쓴다.
        const dir = await ensureOwnDir(dirname(dirname(this.path)), basename(dirname(this.path)));
        // ⚠ **만든 뒤에 죈다.** [ensureOwnDir] 은 `mkdir` 기본 모드로 만들고, 그것은 umask 를 타
        //   보통 0775 다(실측). 만들 때 모드를 줄 손잡이가 그 함수에 없으므로 여기서 명시한다 —
        //   같은 기계의 다른 사용자가 이 폴더를 들여다볼 이유가 없다.
        await chmod(dir, 0o700).catch(() => {});
        await writeOwnFile(this.path, JSON.stringify(tokens), 0o600);
        // 임시 파일에 준 `mode` 는 `rename` 을 타고 그대로 오지만, **이미 있던 파일을 바꾸는**
        // 경우에도 확실히 죄기 위해 한 번 더 부른다.
        // ⚠ 이 둘은 **짝이 아니다.** 아래 `chmod` 는 「이미 있던 헐거운 파일」 시험이 단독으로
        //    잡고, 위의 `mode` 는 어떤 시험도 단독으로 못 잡는다 — 시험은 **최종 권한**만 잴 수
        //    있는데 `chmod` 가 그것을 맞춰 놓기 때문이다(심의 재실측 · 재현:
        //    `node --test --experimental-strip-types packages/cli/src/tokenStore.test.ts` 를
        //    각 줄을 지운 채로 돌린다 — `mode` 만 지우면 6 통과, `chmod` 만 지우면 1 실패).
        //    그래도 위의 `mode` 를 남기는 이유는 **창을 안 만들기** 위해서다 — 이 줄에 이르기
        //    전까지 파일이 0644 로 존재하는 순간이 있고, 다중 사용자 기계에서 그 창은 실재한다.
        await chmod(this.path, 0o600);
    }

    async clear(): Promise<void> {
        await rm(this.path, {force: true});
    }
}
