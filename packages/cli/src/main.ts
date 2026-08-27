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
    pushSiteSource,
    planStranded,
    publishDraft,
    rebuildBaseline,
    rollbackRevision,
    discardDraft,
    readLedger,
    hashWorkdir,
    PATH_LIST_CAP,
    trimPaths,
    ledgerCorrection,
    writeLedger,
    syncStatus,
    login,
    logout,
    type DraftFiles,
} from "@zalkera/devtools-core";
import {spawn} from "node:child_process";
import {flagOn, flagValue, parseArgs} from "./args.ts";
import {openAuth, openContext, version} from "./context.ts";
import {confirm} from "./confirm.ts";
import {describePush, describeStatus, describeStranded, DISCARD_PHRASE} from "./report.ts";
import {FileTokenStore, tokenPath} from "./tokenStore.ts";

const HELP = `잘커라 — 사이트 소스를 로컬에서 다루는 도구 (v${version()})

  zalkera login                 브라우저로 로그인
  zalkera logout                로그인 정보를 지운다
  zalkera status                이 폴더와 사이트가 어떻게 다른지 본다
  zalkera pull                  사이트의 지금 판을 이 폴더에 받는다
  zalkera push                  이 폴더에서 고친 것을 사이트 쪽에 올린다(켜지지는 않는다)
  zalkera publish               올린 것을 새 버전으로 만든다(그래야 손님에게 보인다)
  zalkera rollback <판번호>      라이브를 그 버전으로 되돌린다
  zalkera discard               사이트 쪽에서 편집 중인 것을 버린다(판은 안 옮긴다)
  zalkera baseline              기준 기록만 지금 판으로 다시 세운다(파일은 안 건드린다)

옵션
  --site <사이트코드>            폴더가 소속을 모를 때 지정한다
  --folder <경로>                이 폴더 대신 다른 폴더를 다룬다
  --revision <판번호>            받을 판을 지정한다(pull · baseline)
  --discard-local                pull 이 막힐 때 고친 것을 옆 폴더로 옮기고 진행한다
  --overwrite-unseen             push 가 막힐 때 사이트 쪽 편집을 덮어쓰고 진행한다(그 편집은 사라진다)
  --label <이름>                 publish 가 붙일 버전 이름
  --discard-pending              publish 가 게시 대기 AI 변경을 함께 버린다
  --discard-draft                rollback 이 편집 중인 것을 함께 버린다
  --yes                          버리기 확인을 미리 준다(터미널이 아닐 때)
  --verbose                      경로를 전부 보여 준다

로그인 정보는 ${tokenPath()} 에 **평문**으로 저장됩니다.
그 컴퓨터를 쓸 수 있는 사람은 이 사이트를 고치고 배포할 수 있습니다.`;

async function main(argv: readonly string[]): Promise<number> {
    const {command, positional, flags} = parseArgs(argv);
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
            // ⚠ **로그인은 사이트를 안 묻는다.** 빈 폴더에서 처음 쓰는 사람이 여기서 「어느 사이트의
            //   것인지 알 수 없습니다」로 막히면, README 가 적은 첫 순서(`login` → `pull`)가 돌지
            //   않는다 — 그리고 사이트를 고르려면 로그인이 먼저다(심의 지적).
            const auth = await openAuth(common);
            await login(auth.auth, auth.store, {openBrowser});
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
                listAll: verbose,
                onProgress: (message: string) => process.stderr.write(`${message}\n`),
            });
            const parts = [
                `${result.revisionNo}판을 받았습니다.`,
                `새로 쓴 것 ${result.written}개 · 지운 것 ${result.deleted}개 · 그대로 둔 것 ${result.unchanged}개`,
            ];
            if (result.untracked > 0) parts.push(`이 폴더에만 있는 파일 ${result.untracked}개는 건드리지 않았습니다.`);
            if (result.savedTo) parts.push(`고쳐 두었던 것은 ${result.savedTo} 에 옮겨 두었습니다.`);
            if (result.foreignLedger) {
                parts.push("이 폴더에 다른 사이트의 기준 기록이 있어 쓰지 않았습니다. 지금은 이 사이트 것으로 되어 있습니다.");
            }
            // ⚠ **조용히 넘기지 않는다.** 이 회차에는 「사이트가 지운 파일을 여기서도 지운다」가
            //   못 돌았다 — 그 사실을 안 말하면 남은 파일이 다음 올리기에서 되살아난다.
            if (result.deletionsUnknown) {
                parts.push(
                    "이 폴더에는 기준 기록이 없었습니다. 그래서 사이트에서 지워진 파일이 여기 남아 있어도 이번에는 지우지 못했습니다.",
                    "지금 남아 있는 것 중 사이트에 없는 파일이 있는지 `zalkera status` 로 확인해 주세요.",
                );
            }
            // ⚠ **조용히 빼지 않는다.** 정본에 이것들이 실려 오는 것 자체가 서버 쪽 결함 신호다 —
            //    말하지 않으면 아무도 그 사실을 모른다.
            if (result.serverExcluded.length > 0) {
                parts.push(
                    `사이트가 보낸 것 중 ${result.serverExcluded.length}개는 이 도구가 다루지 않는 파일이라 받지 않았습니다.`,
                    ...trimPaths(result.serverExcluded, PATH_LIST_CAP, verbose).map((p) => `  · ${p}`),
                );
            }
            if (!result.ledgerWritten) {
                parts.push(
                    "다만 기준 기록을 쓰지 못했습니다. 파일은 새 판입니다.",
                    "`zalkera baseline` 을 한 번 실행해 주세요 — 폴더의 파일은 건드리지 않습니다.",
                );
            }
            process.stdout.write(`${parts.join("\n")}\n`);
            return result.ledgerWritten ? 0 : 1;
        }
        case "push": {
            const context = await openContext(common);
            const result = await pushSiteSource({
                api: context.api,
                folder: context.folder,
                // ⚠ **명시 동의다.** 이 손잡이가 없으면 사이트 쪽에 걸려 있던 남의 편집이 조용히
                //    사라진다 — 선행조건은 그것을 못 막는다.
                overwriteUnseen: flagOn(flags, "overwrite-unseen"),
                listAll: verbose,
                onProgress: (message: string) => process.stderr.write(`${message}\n`),
            });
            const parts = describePush(result, verbose);
            process.stdout.write(`${parts.join("\n")}\n`);
            return 0;
        }
        case "publish": {
            const context = await openContext(common);
            const result = await publishDraft({
                api: context.api,
                folder: context.folder,
                label: flagValue(flags, "label") ?? undefined,
                // ⚠ **명시 동의다.** 게시 대기 AI 변경이 함께 사라진다.
                discardPendingChanges: flagOn(flags, "discard-pending"),
                onProgress: (message: string) => process.stderr.write(`${message}\n`),
            });
            const lines = [
                `${result.revisionNo}판으로 올렸습니다.`,
                result.siteType === "STATIC"
                    ? "지금 바로 손님에게 보입니다."
                    : "사이트를 다시 짓는 중입니다 — 다 지어지면 자동으로 손님에게 보입니다.",
            ];
            if (result.capabilityNote) lines.push(result.capabilityNote);
            if (!result.ledgerRebuilt) {
                lines.push(
                    "",
                    "다만 새 버전의 파일 목록을 읽지 못해 이 폴더의 기준 기록을 지웠습니다.",
                    "`zalkera baseline` 을 한 번 실행해 주세요 — 폴더의 파일은 건드리지 않습니다.",
                );
            }
            process.stdout.write(`${lines.join("\n")}\n`);
            return result.ledgerRebuilt ? 0 : 1;
        }
        case "rollback": {
            const target = revisionArg(positional);
            const context = await openContext(common);
            const result = await rollbackRevision({
                api: context.api,
                folder: context.folder,
                revisionNo: target,
                discardDraft: flagOn(flags, "discard-draft"),
                onProgress: (message: string) => process.stderr.write(`${message}\n`),
            });
            const lines = [
                result.pointerMoved
                    ? `${result.revisionNo}판으로 되돌렸습니다.`
                    : `이미 ${result.revisionNo}판이었습니다.`,
            ];
            if (result.discardedDraft) lines.push("편집 중이던 것은 함께 버렸습니다.");
            if (result.discardedPendingChanges > 0) {
                lines.push(`게시 대기 변경 ${result.discardedPendingChanges}건도 함께 버렸습니다.`);
            }
            lines.push("", "이 폴더의 파일은 건드리지 않았습니다 — 맞추려면 `zalkera pull` 을 실행하세요.");
            if (result.differing.length > 0) {
                lines.push(
                    `⚠ 이 폴더의 ${result.differing.length}개 파일이 ${result.revisionNo}판과 다릅니다.`,
                    ...trimPaths(result.differing, PATH_LIST_CAP, verbose).map((p) => `  · ${p}`),
                    `지금 \`zalkera push\` 를 하면 이 ${result.differing.length}개가 **전부** 올라가 ${result.revisionNo}판의 내용을 덮습니다.`,
                );
            }
            if (!result.ledgerRebuilt) {
                lines.push("", "새 기준의 파일 목록을 읽지 못해 기준 기록을 지웠습니다. `zalkera baseline` 을 실행해 주세요.");
            }
            process.stdout.write(`${lines.join("\n")}\n`);
            return 0;
        }
        case "discard": {
            const context = await openContext(common);
            // 🔴 **무엇을 잃는지 먼저 보여 준다.** 판정이 「여기 없는 편집」이면 한 글자 동의를 안 받는다.
            const draft = await context.api.draftFiles().catch(() => null);
            const plan = planStranded({ledger: await readLedger(context.folder), draft});
            if (plan.paths.length === 0 && plan.reason === "ledger-matches") {
                process.stdout.write("사이트 쪽에 편집 중인 것이 없습니다 — 버릴 것이 없습니다.\n");
                return 0;
            }
            process.stderr.write(`${describeStranded(plan, verbose).join("\n")}\n`);
            const agreed =
                plan.verdict === "mine"
                    ? await confirm({
                          question: "버릴까요? (y/n)",
                          given: flagOn(flags, "yes"),
                          flag: "--yes",
                      })
                    : await confirm({
                          question: `그래도 버리려면 아래를 그대로 입력해 주세요: \`${DISCARD_PHRASE}\``,
                          phrase: DISCARD_PHRASE,
                          given: flagValue(flags, "confirm") === DISCARD_PHRASE,
                          flag: `--confirm ${DISCARD_PHRASE}`,
                      });
            if (!agreed) {
                process.stdout.write("아무것도 버리지 않았습니다.\n");
                return 1;
            }
            const result = await discardDraft({
                api: context.api,
                folder: context.folder,
                onProgress: (message: string) => process.stderr.write(`${message}\n`),
            });
            const lines = [result.hadDraft ? "편집 중이던 것을 버렸습니다." : "버릴 편집이 없었습니다."];
            if (result.discardedPendingChanges > 0) {
                lines.push(`게시 대기 변경 ${result.discardedPendingChanges}건도 함께 버렸습니다.`);
            }
            lines.push("이 폴더의 파일은 건드리지 않았습니다.");
            process.stdout.write(`${lines.join("\n")}\n`);
            return 0;
        }
        case "baseline": {
            const context = await openContext(common);
            const result = await rebuildBaseline({
                api: context.api,
                folder: context.folder,
                revisionNo,
                onProgress: (message: string) => process.stderr.write(`${message}\n`),
            });
            const lines = [
                `${result.revisionNo}판(파일 ${result.files}개)을 기준으로 ${result.replaced ? "다시 " : ""}세웠습니다.`,
                "폴더의 파일은 건드리지 않았습니다.",
            ];
            // 🔴 **전제가 깨졌으면 말한다.** 이 동사는 「이 폴더가 그 판에 있다」를 전제로 기준을
            //    세운다. 다른 것이 많으면 그 기준은 그만큼 거짓이고, 그 상태로 올리면 **내가 만진 적
            //    없는 파일까지** 그 판을 덮는다(실측: 만진 것 1개 · 나간 것 4개).
            if (result.differing.length > 0) {
                lines.push(
                    "",
                    `⚠ 이 폴더의 ${result.differing.length}개 파일이 ${result.revisionNo}판과 다릅니다.`,
                    ...trimPaths(result.differing, PATH_LIST_CAP, verbose).map((p) => `  · ${p}`),
                    `지금 \`zalkera push\` 를 하면 이 ${result.differing.length}개가 **전부** 올라가 ${result.revisionNo}판의 내용을 덮습니다.`,
                    "고친 것이 그중 일부뿐이라면 `zalkera pull` 로 받는 쪽이 맞습니다.",
                );
            } else {
                lines.push("지금 상태는 `zalkera status` 로 볼 수 있습니다.");
            }
            // 형제 `pull` 과 같은 규율 — 조용히 빼지 않는다.
            if (result.serverExcluded.length > 0) {
                lines.push(
                    "",
                    `사이트가 보낸 것 중 ${result.serverExcluded.length}개는 이 도구가 다루지 않는 파일이라 기준에 넣지 않았습니다.`,
                    ...trimPaths(result.serverExcluded, PATH_LIST_CAP, verbose).map((p) => `  · ${p}`),
                );
            }
            process.stdout.write(`${lines.join("\n")}\n`);
            return 0;
        }
        default:
            process.stderr.write(`모르는 명령입니다: ${command}\n\n${HELP}\n`);
            return 2;
    }
}

/** 위치 인자의 판 번호(`zalkera rollback 5`). 없거나 숫자가 아니면 **거절한다.** */
function revisionArg(positional: readonly string[]): number {
    const raw = positional[0];
    const value = Number(raw);
    if (raw === undefined || !Number.isInteger(value) || value <= 0) {
        throw new DevtoolsError(
            "SERVER_REJECTED",
            `되돌릴 버전 번호를 주세요(예: \`zalkera rollback 5\`).${raw === undefined ? "" : ` 받은 값: ${raw}`}`,
            "`zalkera status` 로 지금 켜진 버전을 볼 수 있습니다.",
        );
    }
    return value;
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
 * 브라우저를 연다. **열지 못하면 주소를 내주고 계속 기다린다.**
 *
 * ⚠ 코어의 [LoginOptions] 는 「열지 못했으면 `CANCELLED` 로 던져라」고 적는다. **여기는 일부러
 *   벗어난다** — 그 규율은 확장의 형상을 두고 쓴 것이다. 거기서는 호스트가 「외부 사이트를
 *   여시겠습니까?」를 띄우고 사람이 **거절할 수 있어서**, 안 던지면 열리지도 않은 브라우저의
 *   콜백을 기다리며 매달린다.
 *
 *   터미널은 다르다. 원격 셸·컨테이너·SSH 에는 브라우저가 **없는 것이 정상**이고, 거기서 던지면
 *   로그인 길이 아예 없어진다. 그래서 주소를 찍고 기다린다 — 사람이 다른 기계에서 그 주소를 열면
 *   루프백 수신기가 코드를 받는다. 정말 못 하면 타임아웃이 끝낸다.
 */
async function openBrowser(url: string): Promise<void> {
    // 🔴 **윈도에서 `shell: true` 를 쓰지 않는다.** Node 는 그때 인자를 **따옴표 없이** 이어 붙여
    //    `cmd /d /s /c "…"` 로 넘기는데, `/s` 가 바깥 따옴표를 벗기면 authorize URL 의 `&` 가
    //    명령 구분자로 남는다 — 브라우저는 `client_id` 까지만 받고(=인가 실패) 나머지 조각은
    //    cmd 가 명령으로 실행한다. 질의 인자가 일곱이라 `&` 는 **항상** 있다.
    //    `cmd /c start "" <url>` 를 **인자 배열**로 넘기면 그 결합이 아예 안 일어난다.
    const [command, args] =
        process.platform === "darwin"
            ? ["open", [url]]
            : process.platform === "win32"
              ? ["cmd", ["/c", "start", "", url]]
              : ["xdg-open", [url]];
    await new Promise<void>((resolve, reject) => {
        const child = spawn(command as string, args as string[], {stdio: "ignore", detached: true});
        child.on("error", reject);
        child.on("spawn", () => {
            child.unref();
            resolve();
        });
    }).catch(() => {
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
