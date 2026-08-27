/**
 * **로컬 도구의 로그인 파일이 어디 있는가** — 경로 계산만 한다.
 *
 * ⚠ **파일을 여기서 쓰지 않는다.** 「코어는 파일을 안 쓴다」는 약속이 있고, 보관소 구현
 *   (`FileTokenStore`)은 CLI 에 남는다. 이 함수는 **순수**라 그 약속 밖이다.
 *
 * ■ 왜 코어에 있나
 *   확장도 이 자리를 알아야 한다 — 「소스 다루게 하기」가 적는 설정은 **CLI 프로세스**가 이
 *   파일을 읽어 돈다. 확장의 로그인(VS Code SecretStorage)은 그 프로세스에서 안 보이므로,
 *   확장은 「여기에 로그인이 있는가」를 물어야 사람에게 정직한 안내를 할 수 있다.
 */
import {homedir} from "node:os";
import {isAbsolute, join, resolve, sep} from "node:path";

/**
 * 보관 자리. `XDG_CONFIG_HOME` 을 존중하되 **홈 아래로 고정**한다.
 *
 * 🔴 **절대경로라고 다 받으면 안 된다**(심의 실측). `XDG_CONFIG_HOME=$PWD/.config` 는 CI·devcontainer·
 *    direnv 에서 실재하는 관례고, 이 도구는 스스로 「스크립트·CI 에서 돌릴 때를 위한 것」이라 적는다.
 *    그 값을 그대로 쓰면 refresh 토큰이 **소스 폴더 안**에 떨어지고, 그 폴더는 zip 으로 포장돼
 *    유통되는 경로다 — 「내 사이트 소스 보내 주세요」 한 번에 발행 권한이 넘어간다.
 *
 * ⚠ 그래서 판정은 「절대경로인가」가 아니라 **「홈 아래인가」**다. 아니면 조용히 기본 자리로 되돌린다 —
 *   여기서 던지면 남의 환경 설정 하나로 도구가 아예 안 뜬다.
 */
export function tokenPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
    const fallback = join(home, ".config");
    const base = env.XDG_CONFIG_HOME;
    const inside =
        base !== undefined &&
        isAbsolute(base) &&
        (resolve(base) === resolve(home) || resolve(base).startsWith(resolve(home) + sep));
    return join(inside ? resolve(base!) : fallback, "zalkera", "auth.json");
}
