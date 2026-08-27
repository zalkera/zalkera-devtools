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
import {chmod, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {homedir} from "node:os";
import {dirname, join} from "node:path";
import type {StoredTokens, TokenStore} from "@zalkera/devtools-core";

/** 보관 자리. `XDG_CONFIG_HOME` 을 존중하되 **홈 아래로 고정**한다. */
export function tokenPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
    const base = env.XDG_CONFIG_HOME;
    // ⚠ 상대 경로는 **쓰지 않는다**(XDG 명세도 절대경로만 유효하다고 적는다). 상대값을 받아들이면
    //   프로세스의 작업 폴더 — 즉 **소스 폴더** — 아래에 토큰이 떨어진다.
    const root = base && base.startsWith("/") ? base : join(home, ".config");
    return join(root, "zalkera", "auth.json");
}

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
        await mkdir(dirname(this.path), {recursive: true, mode: 0o700});
        // ⚠ **권한을 만들 때 준다.** 먼저 쓰고 나중에 `chmod` 하면 그 사이에 0644 로 존재하는 창이
        //   생기고, 그 창은 다중 사용자 기계에서 실재하는 창이다.
        await writeFile(this.path, JSON.stringify(tokens), {mode: 0o600});
        // 파일이 이미 있었으면 `mode` 는 무시된다 — 그래서 한 번 더 죈다.
        // ⚠ 이 둘은 **짝이다.** 시험은 최종 권한만 잴 수 있어 한쪽만 빼면 안 깨진다(변이 실측).
        //    그래도 위의 `mode` 를 남기는 이유는 **창을 안 만들기** 위해서다 — 아래 줄에 이르기
        //    전까지 파일이 0644 로 존재하는 순간이 있고, 다중 사용자 기계에서 그 창은 실재한다.
        await chmod(this.path, 0o600);
    }

    async clear(): Promise<void> {
        await rm(this.path, {force: true});
    }
}
