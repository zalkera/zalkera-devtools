#!/usr/bin/env node
/**
 * **`zalkera` — 터미널에서 쓰는 길.**
 *
 * VS Code 를 안 쓰거나, 스크립트·CI 에서 돌릴 때를 위한 것이다. **로직은 전부
 * `@zalkera/devtools-core` 에 있다** — 이 패키지는 인자 해석과 출력만 맡는다. 그래야 확장과 CLI 가
 * 같은 판정을 지나고, 「확장에서는 되는데 CLI 에서는 다르게 된다」가 안 생긴다.
 *
 * ⚠ **이 파일에 판정을 두지 마라.** 여기 한 줄을 더하면 그 줄은 확장이 안 지나는 줄이 된다.
 */
import {
    DevtoolsError,
    pullSiteSource,
    rebuildBaseline,
    readLedger,
    hashWorkdir,
    ledgerCorrection,
    writeLedger,
    syncStatus,
    login,
    logout,
    type DraftFiles,
} from "@zalkera/devtools-core";
import {spawn} from "node:child_process";
import {flagOn, flagValue, parseArgs} from "./args.ts";
import {openContext, version} from "./context.ts";
import {describeStatus, trim} from "./report.ts";
import {FileTokenStore, tokenPath} from "./tokenStore.ts";

const HELP = `잘커라 — 사이트 소스를 로컬에서 다루는 도구 (v${version()})

  zalkera login                 브라우저로 로그인
  zalkera logout                로그인 정보를 지운다
  zalkera status                이 폴더와 사이트가 어떻게 다른지 본다
  zalkera pull                  사이트의 지금 판을 이 폴더에 받는다
  zalkera baseline              기준 기록만 지금 판으로 다시 세운다(파일은 안 건드린다)

옵션
  --site <사이트코드>            폴더가 소속을 모를 때 지정한다
  --folder <경로>                이 폴더 대신 다른 폴더를 다룬다
  --revision <판번호>            받을 판을 지정한다(pull · baseline)
  --discard-local                pull 이 막힐 때 고친 것을 옆 폴더로 옮기고 진행한다
  --verbose                      경로를 전부 보여 준다

로그인 정보는 ${tokenPath()} 에 **평문**으로 저장됩니다.
그 컴퓨터를 쓸 수 있는 사람은 이 사이트를 고치고 배포할 수 있습니다.`;

async function main(argv: readonly string[]): Promise<number> {
    const {command, flags} = parseArgs(argv);
    // ⚠ **판 물음이 먼저다.** 도움말 갈래가 「명령이 없으면」을 먼저 보면 `--version` 은 명령이
    //   없는 호출이라 도움말이 나온다 — 스크립트가 판을 읽으려다 도움말을 파싱하게 된다.
    if (command === "version" || flagOn(flags, "version")) {
        process.stdout.write(`${version()}\n`);
        return 0;
    }
    if (command === null || command === "help" || flagOn(flags, "help")) {
        process.stdout.write(`${HELP}\n`);
        return 0;
    }

    const verbose = flagOn(flags, "verbose");
    const common = {
        folder: flagValue(flags, "folder") ?? undefined,
        tenant: flagValue(flags, "site") ?? undefined,
    };
    // ⚠ **인자 검증이 네트워크보다 먼저다.** 뒤에 두면 오타 하나가 핸드셰이크 왕복을 치른 뒤에야
    //   드러나고, 이 갈래를 재는 시험이 **상용 서버를 두드린다**(실측으로 그랬다).
    const revisionNo = revisionOf(flags);

    switch (command) {
        case "login": {
            const context = await openContext(common);
            await login(context.auth, context.store, {openBrowser});
            process.stdout.write(`로그인했습니다. 로그인 정보는 ${tokenPath()} 에 있습니다.\n`);
            return 0;
        }
        case "logout": {
            await logout(new FileTokenStore());
            process.stdout.write("로그인 정보를 지웠습니다.\n");
            return 0;
        }
        case "status": {
            const context = await openContext(common);
            // ⚠ **서버 상태를 못 읽었을 때 장부로 폴백하지 않는다.** 폴백하는 순간 「이미 반영됨」이
            //    남이 되돌린 뒤에도 참이 된다(memo184 🔴1).
            const draft: DraftFiles | null = await context.api.draftFiles().catch(() => null);
            const active = await context.api
                .listRevisions(20)
                .then((rows) => rows.find((r) => r.isActive)?.revisionNo ?? null)
                .catch(() => null);
            const ledger = await readLedger(context.folder);
            const status = syncStatus({
                ledger,
                local: await hashWorkdir(context.folder),
                draft,
                activeRevisionNo: active,
            });
            process.stdout.write(`${describeStatus(status, verbose)}\n`);
            // ⚠ **본 것을 장부에 정정한다**(§2.1 전이표). 세대가 갈렸으면 그 장부의 소유 기록은 지난
            //    세계의 것이다 — 그대로 두면 뒤 걸음이 없는 소유를 근거로 판정한다. 못 쓰는 것은
            //    치명적이지 않다(다음 실행이 다시 본다). 그래서 실패를 삼킨다.
            const corrected = ledgerCorrection(ledger, draft);
            if (corrected) await writeLedger(context.folder, corrected);
            // 막힌 것이 있으면 **종료 코드로도** 말한다 — 스크립트가 그것으로 갈린다.
            return status.blockers.length > 0 ? 1 : 0;
        }
        case "pull": {
            const context = await openContext(common);
            const result = await pullSiteSource({
                api: context.api,
                folder: context.folder,
                revisionNo,
                discardLocal: flagOn(flags, "discard-local"),
                onProgress: (message: string) => process.stderr.write(`${message}\n`),
            });
            const parts = [
                `${result.revisionNo}판을 받았습니다.`,
                `새로 쓴 것 ${result.written}개 · 지운 것 ${result.deleted}개 · 그대로 둔 것 ${result.unchanged}개`,
            ];
            if (result.untracked > 0) parts.push(`이 폴더에만 있는 파일 ${result.untracked}개는 건드리지 않았습니다.`);
            if (result.savedTo) parts.push(`고쳐 두었던 것은 ${result.savedTo} 에 옮겨 두었습니다.`);
            if (!result.ledgerWritten) {
                parts.push(
                    "다만 기준 기록을 쓰지 못했습니다. 파일은 새 판입니다.",
                    "`zalkera baseline` 을 한 번 실행해 주세요 — 폴더의 파일은 건드리지 않습니다.",
                );
            }
            process.stdout.write(`${parts.join("\n")}\n`);
            return result.ledgerWritten ? 0 : 1;
        }
        case "baseline": {
            const context = await openContext(common);
            const result = await rebuildBaseline({
                api: context.api,
                folder: context.folder,
                revisionNo,
                onProgress: (message: string) => process.stderr.write(`${message}\n`),
            });
            process.stdout.write(
                `${result.revisionNo}판(파일 ${result.files}개)을 기준으로 ${result.replaced ? "다시 " : ""}세웠습니다.\n` +
                    "폴더의 파일은 건드리지 않았습니다. 지금 상태는 `zalkera status` 로 볼 수 있습니다.\n",
            );
            return 0;
        }
        default:
            process.stderr.write(`모르는 명령입니다: ${command}\n\n${HELP}\n`);
            return 2;
    }
}

/** `--revision` 을 판 번호로. 숫자가 아니면 **거절한다** — 조용히 활성 판을 받으면 엉뚱한 판이 온다. */
function revisionOf(flags: ReturnType<typeof parseArgs>["flags"]): number | undefined {
    const raw = flagValue(flags, "revision");
    if (raw === null) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        throw new DevtoolsError("SERVER_REJECTED", `판 번호가 올바르지 않습니다: ${raw}`);
    }
    return value;
}

/**
 * 브라우저를 연다. **열지 못했으면 던진다** — 조용히 넘어가면 브라우저는 안 열렸는데 콜백을
 * 기다리며 매달린다(코어 [LoginOptions] KDoc 이 못박은 자리).
 */
async function openBrowser(url: string): Promise<void> {
    const command =
        process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    await new Promise<void>((resolve, reject) => {
        const child = spawn(command, [url], {stdio: "ignore", detached: true, shell: process.platform === "win32"});
        child.on("error", reject);
        child.on("spawn", () => {
            child.unref();
            resolve();
        });
    }).catch(() => {
        // 던지지 않고 **주소를 내준다.** 원격 셸·컨테이너에는 브라우저가 없는 것이 정상이고,
        // 거기서 "실패"라고 끝내면 로그인 길이 아예 없다.
        process.stderr.write(`브라우저를 열지 못했습니다. 이 주소를 직접 열어 주세요:\n${url}\n`);
    });
}

const code = await main(process.argv.slice(2)).catch((error: unknown) => {
    if (error instanceof DevtoolsError) {
        process.stderr.write(`${error.humanMessage}\n`);
        return 1;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
});
process.exit(code);
