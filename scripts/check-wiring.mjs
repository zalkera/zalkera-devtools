#!/usr/bin/env node
/**
 * **배선 검사 — 판정을 부르는 자리가 살아 있는가.**
 *
 * ■ 왜 생겼나
 *   이 레포는 판정을 core 로 내려 시험이 물게 해 왔다. 그런데 심의가 변이 21건을 걸어 보니
 *   **9건이 전건 초록으로 살아남았고, 전부 「판정을 부르는 배선」**이었다. `devEngineArgs()` 자체는
 *   시험이 무는데 그것을 `spawn` 인자에 넘기는 한 줄은 아무도 안 물었다 — 그 줄만 지우면 Node
 *   없는 컴퓨터 전원이 첫 화면 500 으로 돌아가는데 시험 전건이 초록이었다.
 *
 * ■ **존재가 아니라 횟수를 센다**
 *   같은 조각이 두 자리에 있으면 「있는가」는 하나만 남아도 참이다. 실측으로 그 형상이 있었다 —
 *   `if (previewGuard.busy)` 가 두 곳(로그아웃 거절·미리보기 재진입)에 있어서, 로그아웃 쪽을
 *   무력화해도 이 검사기가 초록이었다. 그래서 목록의 넷째 칸이 **기대 횟수**다(생략하면 1).
 *
 * ■ **래퍼 안쪽도 목록에 적는다**
 *   호출부(`await whileExtracting(() => …)`)만 고정하면 그 래퍼의 본문을 비워도 안 걸린다.
 *   가드가 실제로 서는 줄을 따로 적는다.
 *
 * ■ 왜 AST 가 아니라 문면인가
 *   여기서 재는 것은 **한 줄이 있는가**다. 형태가 바뀌면 이 검사기가 「못 찾았다」로 서야 하고,
 *   그때 사람이 와서 배선이 여전한지 보는 것이 맞다. 조용히 통과하는 쪽이 훨씬 나쁘다.
 *   (`check-upgrade-notice.mjs` 가 같은 규율을 쓴다.)
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

/** [파일, 있어야 하는 조각, 사라지면 무슨 일이 나는가] */
const WIRES = [
    [
        "packages/vscode/src/extension.ts",
        "folderTenant: currentFolderBinding()",
        "게이트·사이드바·상태바가 서로 다른 기준으로 소속을 판정해, 화면마다 다른 말을 한다",
        3,
    ],
    [
        "packages/vscode/src/extension.ts",
        "const scope = decideTenantScope({",
        "사이트 선택이 다시 남의 폴더 링크를 덮는다 — 이 판을 만든 그 결함이 되살아난다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "if (target === undefined) return;",
        "판정을 부르고도 결과를 무시해, 소속 다른 폴더의 선택이 전역에 적힌다 — 그 값은 표식 없는 폴더를 여는 순간 되살아나 게이트가 설 수 없는 자리에서 교차 업로드가 된다",
    ],
    [
        "packages/vscode/src/extension.ts",
        'case "none":',
        "쓰기 대상 판정이 전수가 아니게 되어 `none` 이 전역으로 흘러간다",
    ],
    [
        "packages/vscode/src/extension.ts",
        'register("zalkera.site.useFolder", useFolderSite)',
        "어긋난 폴더의 복귀 버튼이 아무 명령도 못 부르고, 그 폴더가 갇힌다",
    ],
    [
        "packages/vscode/src/extension.ts",
        'origin: "published"',
        "발행이 소속을 결정화하지 않아, 표식 없는 폴더가 영원히 게이트 밖에 남는다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "await markFolderLinked(dir, String(pinned));",
        "직접 고른 폴더의 소속이 링크에만 실려, zip·git 으로 안 따라가고 손 편집·구판 확장에 덮인다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "await markFolderLinked(dir, choice.description);",
        "재연결이 표식을 안 남겨 링크와 표식이 갈리고, 「어긋남은 사고다」가 성립하지 않는다",
    ],
    [
        // ⚠ **효과를 센다.** 호출부 문자열만 고정하면 헬퍼 본체를 무동작으로 바꿔도 초록이다 —
        //    두 경로의 표식 쓰기가 한꺼번에 죽는데 아무도 안 잡는다(변이로 실측해 뚫렸다).
        "packages/vscode/src/extension.ts",
        "linkedAt: new Date().toISOString(),",
        "표식 헬퍼가 이름만 남고 아무것도 안 써도 검사가 초록이 된다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "const linked = await linkFolderToTenant(dir, String(pinned));",
        "직접 고르기가 링크를 안 써 새 창의 유효 사이트가 전역 잔값이 된다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "if (plan.kind === \"refuse\") {",
        "남의 사이트 소스 폴더를 그 사이트 폴더로 열어 주고, 그 폴더의 링크를 덮는다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "elsewhereOptions({ confirmedDir, fetchable: \"unknown\" })",
        "선택지를 손으로 짜면 판 없는 사이트에 「누르면 실패하는 받기」가 되살아난다",
    ],
    [
        // ⚠ **첫 그리기만 고정하면 절반이다.** 화면을 안 막게 바꾼 뒤로 「받기를 뺀다」는 일은
        //    전적으로 이 조회와 다시 그리는 줄이 한다 — 그 둘이 리팩터링에서 떨어지면 첫 배선은
        //    그대로라 전건 초록인 채 P0 받기 항목이 **상시로** 되살아난다.
        "packages/vscode/src/extension.ts",
        "void probeFetchable(pinned).then((fetchable) => {",
        "조회가 없어져 판 없는 사이트에서도 받기 항목이 그대로 남는다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "quick.items = optionItems(options);",
        "조회 결과가 화면에 반영되지 않아 받기 항목이 그대로 남는다",
    ],
    [
        // ⚠ **이 자리는 두 번 틀렸다**(받은 곳이 지금 폴더 자신인 칸 · 꾸러미가 한 겹 감싼 칸).
        //    세 번째로 고치면서 판정을 core 로 내렸는데, 호출을 지우고 종전 삼항을 되살려도
        //    시험·검사기가 전건 초록이었다(변이 실측). 형제 판정은 이미 등재돼 있는데 이 자리만
        //    빠져 있었다.
        "packages/vscode/src/extension.ts",
        "const { into, needsOpen } = decideFetchedInto({",
        "받기 완료 문면 판정이 확장 안 조건문으로 돌아가, 지금 폴더에 받고도 「바뀌지 않았습니다」가 되살아난다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "const plan = decideFetchTargetPlan({",
        "받을 자리 판정이 확장 안 조건문으로 흩어져 열어 둔 빈 폴더 활용이 조용히 꺼진다",
        2,
    ],
    [
        "packages/vscode/src/extension.ts",
        "rememberOpenFolder();",
        "로그아웃 뒤 로컬본이 디스크에 있는데도 「받기」를 권하는 상태로 되돌아간다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "await vscode.commands.executeCommand(\"zalkera.site.link\");",
        "잘못 입양된 폴더를 되돌리는 길이 화면에서 사라진다",
    ],
    [
        "packages/vscode/src/extension.ts",
        'origin: "linked"',
        "재연결이 표식을 안 남겨 링크와 표식이 갈리고, 「어긋남은 사고다」가 성립하지 않는다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "await removeAdded(targetDir, before);",
        "들여오기가 도중에 멈추면 반쪽 해제가 남는다 — 배송 문서의 「폴더는 그대로입니다」가 거짓이 되고, 재시도가 「비어 있지 않습니다」로 막혀 손으로 지우기 전에는 못 빠져나온다. 이 레포가 같은 회귀를 세 번째 겪은 자리다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "if (ok !== provNotice.action) return;",
        "되돌릴 수 없는 조작의 **유일한 동의 관문**이다. 지우면 zip 을 고르는 순간 폴더가 사라진다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "if (ok !== provNotice.action) return;\n\n  // ⚠ **먼저 멈춘다.**",
        "확인 «뒤»에 멈춰야 한다 — 동의도 안 받고 남의 미리보기를 끊으면 안 된다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "vscode.workspace.onDidChangeTextDocument((e) => {",
        "보호 경로 경고가 **여는 시점**에만 걸린다 — 그러면 `doc.isDirty` 가드에 늘 걸려 경고가 " +
            "한 번도 안 뜬다(실측: 치환이 안 걸린 채 시험 524개·검사기 14종이 전부 초록이었다). " +
            "고치는 시점이 없으면 이 안전장치는 꺼진 것이다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "vscode.workspace.onDidOpenTextDocument((doc) => warnProtectedPath(doc)),",
        "에이전트·`git checkout` 처럼 **디스크에 직접 쓰는 손**이 만든 변화를 사람이 알 기회가 사라진다 — " +
            "그 손은 편집 알림을 «깨끗한» 문서로 내므로 타이핑 갈래가 구조적으로 못 잡는다(심의 실증)",
    ],
    [
        "packages/vscode/src/extension.ts",
        "if (e.contentChanges.length > 0 && e.document.isDirty) warnProtectedPath(e.document);",
        "디스크에서 다시 읽힌 것까지 편집으로 본다 — **우리가 쓴 `.env.local`** 을 두고 사용자에게 경고한다",
    ],
    [
        "packages/vscode/src/extension.ts",
        'return kind === "credential" ? workspaceScopedState : persistedState;',
        "자격증명 경고가 **기계에서 한 번**이 된다 — `.env` 는 사이트마다 다른 비밀을 지키므로, " +
            "처음 연 사이트에서 한 번 뜨고 다른 고객사 소스를 처음 손댈 때는 조용해진다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "await workspaceScopedState.update(WARNED_KINDS_STATE, undefined);",
        "「초기화」가 자격증명 경고 기록만 남긴다 — 「처음 상태로」라 말해 놓고 되돌릴 길이 화면에 없어진다",
    ],
    [
        "packages/core/src/publish.ts",
        "provenanceTenant: options.tenant,",
        "발행이 출처를 안 찍으면 그 사이트에서 나온 소스가 영원히 «모름»으로 남는다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "const provenanceTenant = currentFolderBinding() ?? undefined;",
        "내보내기의 출처가 폴더 소속에서 안 오면 남의 사이트 이름을 찍거나 아무것도 안 찍는다",
    ],
    [
        // ⚠ **소비처가 둘이다**(갈아 끼우기·사이트를 아는 시작). 하나만 세면 다른 하나를 벗겨도
        //    초록이다. 시작 쪽이 필요한 이유: 그 흐름은 푼 폴더를 그 사이트에 **붙이므로**,
        //    어긋난 출처를 조용히 넘기면 남의 소스를 담은 폴더가 이 사이트 것이라고 주장한다.
        "packages/vscode/src/extension.ts",
        "const prov = await readProvenance(zip, plan);",
        "출처 판정이 사라지면 다른 사이트의 zip 을 무경고로 갈아 끼우거나 무경고로 이 사이트에 붙인다 — 다중 사이트의 최대 사고다",
        2,
    ],
    [
        // ⚠ **「이 폴더」의 지시대상을 공급하는 줄.** 배송 문면 열두 자리가 「이 폴더」라고 말하는데
        //    화면에 그 폴더가 없었다. 게이트가 보는 값(`workspaceDir()`) 하나에서 나와야 한다 —
        //    다른 값을 그리면 지시대상이 또 갈린다.
        "packages/vscode/src/extension.ts",
        "folderPath: dir ?? null,",
        "사이드바가 「이 폴더」의 지시대상을 잃는다 — 「사이트에 연결」·발행 확인이 가리키는 대상이 화면에서 사라진다",
    ],
    [
        // ⚠ **효과를 센다.** 판정을 부르고도 결과를 안 쓰면 확증 안 된 레지스트리 경로를
        //    「그 사이트 폴더」로 열어 주는 손짜기 목록이 되살아난다.
        "packages/vscode/src/extension.ts",
        "const plan = changeFolderPlan({",
        "「작업 폴더 변경」이 확증을 안 지나, 기억만 믿고 남의 폴더를 그 사이트 폴더로 열어 준다",
    ],
    [
        // ⚠ **횟수다.** 「작업 폴더 변경」 두 갈래가 각각 이 문을 지나야 한다 — 직접
        //    `vscode.openFolder` 를 부르면 미리보기가 도는 창을 무경고로 뺏는다.
        "packages/vscode/src/extension.ts",
        "await openSiteFolder(",
        "폴더를 여는 길이 미리보기·미저장 편집 보호를 건너뛴다 — 파일 → 폴더 열기에 없는 그 보호가 이 문의 값어치 절반이다",
        5,
    ],
    [
        "packages/vscode/src/extension.ts",
        "say.publishConfirm(tenant, dir, currentFolderBinding())",
        "발행 확인이 소속을 안 봐 늘 일상 갈래가 되고(반사가 삼킨다) 「이 폴더」의 지시대상도 잃는다",
    ],
    [
        // ⚠ **맨몸 `executeCommand` 로 돌아가면 고른 사이트가 그 자리에서 버려진다.** 형제 `fetch`
        //    갈래는 `openSite(pinned)` 로 들고 가는데 zip 갈래만 안 들고 가던 것이 이 결함이었다.
        "packages/vscode/src/extension.ts",
        "await importZipCommand(pinned);",
        "사이트를 골라 시작했는데 푼 폴더가 어느 사이트 것인지 아무 데도 안 적힌다 — 사람이 「사이트에 연결」로 같은 선택을 한 번 더 하고, 그 사이 창의 유효 사이트는 옛 사이트로 남는다",
    ],
    [
        // ⚠ **판독기가 둘이면 한쪽만 고쳐진다.** 이 줄이 사라지면 「없다」와 「못 읽었다」를 가르는
        //    3상 판독이 종전의 2상으로 돌아가고, 그 접힘이 재바인딩 금지 가드를 연다(보안 심의 🟠).
        "packages/vscode/src/extension.ts",
        "return linkedTenantOf(workspaceLinkState(dir));",
        "링크 판독이 「못 읽었다」를 「소속 없음」으로 접어, JSONC `settings.json` 을 쓰는 폴더의 소속을 zip 풀기가 무동의로 갈아탄다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "await chooseImportTarget(pinned);",
        "풀 자리 제안이 사이트를 모르게 되어, 「빈 폴더를 새로 만들어 고르세요」가 되살아난다 — 비개발자가 멈추는 그 자리다",
    ],
    [
        // ⚠ **효과를 센다.** 부르는 줄만 고정하면 헬퍼 본체를 무동작으로 바꿔도 초록이다.
        "packages/vscode/src/extension.ts",
        "await bindImportedFolder(target, pinned, bindPlan)",
        "푼 폴더가 사이트에 안 붙어, 열어도 유효 사이트가 안 서고 미리보기·올리기가 막힌다",
    ],
    [
        // ⚠ 이 줄이 **소속을 바꾸는 동사를 「사이트에 연결」 하나로 남긴다**는 규율의 집행부다.
        //    빈 폴더 강제가 `.vscode` 를 통과시키므로(`emptyDir.ts` 의 IGNORED), 링크만 가진
        //    남의 폴더가 실제로 여기까지 온다.
        "packages/vscode/src/extension.ts",
        "const bindPlan =",
        "남의 사이트에 붙어 있던 폴더의 소속을 zip 풀기가 조용히 갈아탄다 — 가장 위험한 동사가 가장 흔한 흐름의 한 클릭 거리에 놓인다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "const provNotice = provenanceNotice(verdict",
        "판정을 내고도 안 보여 주면 사람이 동의할 재료가 없다 — 확인 창이 이 게이트의 표면이다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "const keep = await keepNames(dir);",
        "손 목록으로 열거하면 포장기가 빼는 것과 갈린다 — 갈린 쪽이 영구 삭제된다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "replaceContents(dir, [SOURCE_MARK_PATH], keep,",
        "보존·보류 목록이 빠지면 고객의 .git·시크릿·에디터 설정이 영구히 사라진다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "return {zip, plan: decideImportPlan(listZipEntries(zip))};",
        "들여오기가 판정을 안 지나 아무 zip 이나 풀리고, 보낸 쪽 .vscode 가 들어와 그 폴더가 남의 사이트라고 주장한다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "() => packProject({projectDir: dir, provenanceTenant, onProgress: log}),",
        "내보내기가 발행과 다른 포장기를 쓰면 규칙이 갈리고, 손 압축과 같아져 자격증명이 딸려 나간다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "if (session === null) showIdleStatus();",
        "사이드바만 새로 그려 상태바가 낡은 사이트를 말한다 — 어긋남 경고를 눌러 되돌려도 경고가 그대로 남는다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "const plan = idleStatusPlan({",
        "상태바가 core 판정을 안 지나 어긋남 술어가 세 벌이 된다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "await openSite(pinned);",
        "제안 흐름의 받기가 라이브 사이트를 읽어 엉뚱한 사이트의 소스를 내려받는다(겹침은 `whileExtracting` 이 막는다)",
    ],
    [
        "packages/core/src/dev.ts",
        "...engineArgs",
        "Node 없는 컴퓨터에서 미리보기 첫 화면이 500 으로 돌아간다(Turbopack 이 PATH 에서 node 를 못 찾는다)",
    ],
    [
        // ⚠ **등록부가 아니라 «푸는 구간»을 센다.** 진입점에서 잡던 시절, 답하지 않은 알림·파일
        //    대화상자 하나가 가드를 영영 붙들어 형제 명령 둘이 창이 죽을 때까지 막혔다(실사용
        //    신고). 지금은 셋이 각자 해제 직전에 잡으므로 **횟수가 셋**이다 — 하나만 세면 나머지
        //    둘을 벗겨도 초록이 된다.
        "packages/vscode/src/extension.ts",
        "await whileExtracting(() =>",
        "소스 받기·zip 시작·zip 교체가 겹쳐 돌아 두 꾸러미가 같은 폴더에 섞이고, 한쪽 롤백이 다른 쪽 파일을 지운다",
        3,
    ],
    [
        // ⚠ **효과를 센다.** 가드를 부르고도 [BUSY] 를 무시하면, 이미 누가 풀고 있는 폴더에
        //    두 번째 해제가 그대로 들어간다 — 부르는 줄만 세는 검사는 그것을 못 본다.
        "packages/vscode/src/extension.ts",
        "if (result === BUSY) return;",
        "가드가 「이미 푸는 중」이라고 답해도 그대로 밀고 들어가, 가드가 장식이 된다",
        3,
    ],
    [
        "packages/vscode/src/extension.ts",
        'register("zalkera.preset.download", downloadPresetZipCommand)',
        "위와 같다 — 예제 zip 다운로드도 같은 폴더에 푼다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "await previewGuard.run(() => startPreviewGuarded(pinned))",
        "미리보기 시작이 두 번 눌리면 키가 2회 발급돼 두 번째가 첫 번째를 폐기하고, dev 서버 2개가 뜨며 첫 서버는 UI 에서 끌 수 없는 고아가 된다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "if (previewGuard.busy)",
        "⑴ 준비 중 로그아웃이 통과해 사이드바는 로그아웃 화면인데 상태바는 미리보기가 도는 상태로 어긋난다 " +
            "⑵ 미리보기 시작이 겹친다. **두 자리 다** 필요하다 — 하나만 세면 다른 하나를 지워도 안 걸린다",
        2,
    ],
    [
        "packages/vscode/src/extension.ts",
        "if (!choice) throw noRevisionError(revisions);",
        "한 번도 안 올린 사람에게 「빌드 중이거나 실패했습니다」라고 말하고 빈 「버전 이력」으로 보낸다",
        // 「소스 다운로드」와 「소스 zip 다운로드」 둘 다 판을 **먼저 정한다** — 코어 폴백에 맡기면
        // 화면에 말한 판과 받는 판이 갈린다. 둘 다 이 줄을 지녀야 하므로 둘이다.
        2,
    ],
    [
        "packages/vscode/src/extension.ts",
        "if (!needsDiscardConsent(error)) throw error;",
        "서버가 「계속하려면 확인해 주세요」라고 말한 거절에 확인할 자리가 없어져, 버전 전환이 막다른 길이 된다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "await activate(true);",
        "동의를 받아 놓고 서버에는 전하지 않는다 — 같은 거절이 반복된다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "plainNotice(r.label, 80)",
        "버전에 붙인 이름이 「버전 이력」에서 사라진다(백엔드 필드는 `label` 이다 — `note` 로 적으면 늘 undefined 라 조용히 안 보인다)",
    ],
    [
        "packages/vscode/src/extension.ts",
        "await revokeRecordedKeys();",
        "로그아웃·초기화가 다른 창이 켠 미리보기 열쇠를 안 지워, 그 열쇠가 최대 12시간 상용 데이터를 계속 읽는다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "if (!(await signOut({ quiet: true }))) return;",
        "미리보기 준비 중 초기화가 그대로 진행돼, 로그인은 살아 있고 미리보기는 뒤늦게 뜨는데 사이트 설정만 사라진다",
    ],
    [
        "packages/vscode/src/extension.ts",
        'if (notice.kind === "cancelled") return;',
        "사용자가 스스로 그만둔 일이 빨간 오류 창으로 뜬다 — 로그인 창을 닫았을 뿐인데 「인터넷을 확인하세요」를 본다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "const doomed = mine ? addIssuedKey(recordedKeys(), mine) : recordedKeys();",
        "발급 직후 로그아웃하면 그 열쇠가 저장 목록에 아직 없어, 아무도 못 지운 채 최대 12시간 산다",
    ],
    [
        "packages/core/src/dev.ts",
        'child.on("error", () => {',
        "taskkill 이 없는 윈도 기계에서 처리되지 않은 error 이벤트가 되어 확장이 통째로 죽는다(spawn 의 ENOENT 는 던지지 않는다)",
    ],
    [
        "packages/vscode/src/extension.ts",
        "const outcome = await receiveGuard.run(async () => run());",
        "호출부는 `whileExtracting` 을 부르는데 그 **본문**이 가드를 안 지나면 소스 받기가 겹친다 — " +
            "호출줄만 보는 검사는 래퍼 속을 못 본다(심의 실증: 본문을 `await run()` 으로 갈아도 초록이었다)",
    ],
    [
        "packages/vscode/src/extension.ts",
        'if (notice.kind !== "cancelled") {',
        "12시간 자동 갱신 중에 스스로 취소를 누른 사람에게 「갱신하지 못해 미리보기가 멈췄습니다」 빨간창이 뜬다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "plainNotice(r.label, 60)",
        "버전에 붙인 이름이 **고를 때** 안 보인다 — 이력에만 있으면 정작 고르는 자리에서 번호만 보고 고른다(CHANGELOG 가 둘 다 약속한다)",
    ],
    [
        "packages/vscode/src/extension.ts",
        "reapDropped(",
        "목록 상한을 넘어 밀려난 미리보기 열쇠를 아무도 안 지워, 도움말의 「로그아웃하면 폐기됩니다」가 그 자리에서 거짓이 된다",
        3,
    ],
    [
        "packages/vscode/src/extension.ts",
        "onConsent: (serverMessage) => askDiscardConsent(tenant, serverMessage),",
        "새 버전 배포가 zip 을 다 올린 뒤 409 를 받고 「계속하려면 확인해 주세요」만 반복한다 — 확인할 자리가 없는 막다른 길이 된다",
    ],
    [
        "packages/core/src/publish.ts",
        "return await options.api.confirmArchive(storageKey, true);",
        "동의를 받아 놓고 서버에는 전하지 않는다 — 같은 409 가 반복된다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "return answer === ask.action;",
        "동의 창은 뜨는데 **무엇을 누르든 동의**가 된다 — 게시 대기 중인 AI 변경이 사람이 거절해도 사라진다. " +
            "올리기·전환 두 문이 이 한 점을 공유하므로 파급이 둘이다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "if (!(await askDiscardConsent(tenant, (error as Error).message))) return;",
        "전환에서 거절해도 그대로 진행한다 — 사람이 「아니오」를 눌렀는데 AI 변경이 사라진다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "void revokeKeyQuietly(key.keyId, key.tenant);",
        "목록 상한에 밀려난 열쇠를 서버에서 안 지운다 — 그 열쇠가 최대 12시간 산다",
    ],
    [
        "packages/core/src/untar.ts",
        "await writeExclusive(path, data, name, written);",
        "tar 쪽에서 「원래 있던 파일」과 「아카이브 중복 항목」이 다시 뭉친다 — 후자에 「빈 폴더를 만드세요」는 무한 고리다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "if (await announceIfBlocked(command)) return;",
        "사이드바가 일곱 묶음을 항상 보여 주는데 요건이 안 맞는 것을 눌러도 아무 말이 없다 — 「눌러도 아무 일이 없다」에 갇힌다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "vscode.ConfigurationTarget.Workspace,",
        "고른 사이트를 한 범위만 지우면 남은 쪽이 되살아난다",
    ],
    [
        "packages/vscode/src/extension.ts",
        "site: siteDir(),",
        "사이드바·요건 게이트·상태바가 서로 다른 기준으로 「소스가 있나」를 판정한다 — 화면은 없다는데 게이트는 통과시킨다",
        3,
    ],
    [
        "packages/vscode/src/extension.ts",
        "if (isDraftInProgress(error)) {",
        "발행 전 편집 거절이 빨간 오류창에 서버 문장만 남기고 끝난다 — 어디서 처분하는지가 없어 " +
            "재업로드·판 전환이 막다른 길로 회귀한다(memo183 §7). **두 자리다**: zip 재업로드와 판 전환이 " +
            "같은 가드를 지나므로 한쪽만 걸면 다른 문은 그대로 막힌다",
        2,
    ],
    [
        "packages/vscode/src/extension.ts",
        "await tellDraftBlocked(tenant, (error as Error).message);",
        "판정을 부르고도 아무 말을 안 한다 — 조용히 `return` 하면 사용자는 눌렀는데 아무 일도 안 " +
            "일어난 화면을 본다(거절보다 나쁘다)",
        2,
    ],
    [
        "packages/vscode/src/extension.ts",
        "const notice = say.draftBlocked(tenant, serverMessage);",
        "안내 문면을 core 가 아닌 확장이 짓게 되어, 소독·동의어휘 금지 시험이 무는 자리를 벗어난다",
    ],
    [
        "packages/core/src/fetchSource.ts",
        "if (!choice) throw noRevisionError(revisions);",
        "공개 API 로 판을 안 주고 부르면 BUILDING·FAILED 판을 받으러 가고, 「없다」 문면도 옛 사본이 나온다",
    ],
    [
        "packages/core/src/fetchSource.ts",
        "rejectVendored: true",
        "받은 소스가 `node_modules` 를 담고 있어도 그대로 풀린다",
        // 폴더로 푸는 쪽과 zip 으로 다시 싸는 쪽 — 해제가 두 자리라 가드도 두 자리다.
        // 한쪽만 걸면 그쪽으로 받은 소스만 안전해지고, 그 차이는 아무 데도 안 보인다.
        2,
    ],
];

/**
 * **있으면 안 되는 것.** 배선의 반대편이다 — 공용 문을 만들어 놓고 그 문을 **비켜 가는 길**이
 * 열려 있으면, 다음에 생기는 자리가 조용히 그리로 간다(이 레포가 임시 폴더에서 실제로 겪었다:
 * 시험 17개 파일 중 회수까지 하는 것은 여섯이었다).
 *
 * [파일 glob, 있으면 안 되는 조각, 대신 무엇을 쓰나]
 */
const BANS = [
    [
        "packages/vscode/src/*.ts",
        /new Date\(r\.createdAt\)/,
        "core 의 `revisionWhen(r.createdAt)` — 백엔드가 `Instant?` 로 보내므로 널이면 1970-01-01 이 조용히 그려진다",
    ],
    [
        "packages/vscode/src/*.ts",
        /code === "CANCELLED"/,
        "core 의 `isCancelled(error)` — 취소 판정을 확장 안에 사본으로 두면 그 자리만 낡는다" +
            "(실측: 확장에 사본이 셋 있었고, 갱신 타이머의 것은 스스로 취소한 사람에게 빨간창을 띄웠다)",
    ],
    [
        "packages/core/src/*.test.ts",
        /\bmkdtemp(?:Sync)?\s*\(/,
        "`testing/tempDir.ts` 의 `tempDir()`·`tempDirSync()` — 만든 것을 자동으로 회수한다",
    ],
    [
        "packages/core/src/*.test.ts",
        /\btmpdir\s*\(\s*\)/,
        "`tempDir()` — `tmpdir()` 바로 아래에 쓴 것은 회수 대상이 아니다",
    ],
    [
        // ⚠ **이 형태가 실제로 난 사고다.** 진입점에서 받기 가드를 잡으면 로그인·폴더 고르기·
        //    완료 알림까지 덮인다. VS Code 알림은 단추가 달리면 저절로 안 사라지고 파일
        //    대화상자는 창 뒤에 남으므로, 답하지 않은 물음 하나가 가드를 영영 붙든다 —
        //    실수로 누른 「소스 다운로드」 하나에 「zip 으로 시작」·「zip 으로 교체」가 창이
        //    죽을 때까지 막혔다(실사용 신고). 탈출구는 창 다시 열기뿐이었다.
        "packages/vscode/src/*.ts",
        /register\("zalkera\.[^"]*",[\s\S]{0,120}?(?:whileExtracting|[Rr]eceiveGuard)/,
        "`whileExtracting` 을 **아카이브를 푸는 구간**에서만 잡는 형태 — 묻는 자리를 덮으면 답 없는 물음 하나가 형제 명령을 영영 막는다",
    ],
];

/**
 * **계정에 딸린 자리는 목록에서 유도한다.** 손으로 옮겨 적으면 목록과 배선이 갈리고, 그러면
 * 목록이 「지운다」고 적어 둔 것을 아무도 안 지운다.
 *
 * `accountState.ts` 가 자리마다 집행 조각을 들고 있으므로, 여기서는 그것이 확장에 실재하는지만 본다.
 * 목록에 자리를 더하면 배선도 같이 요구된다 — 그것이 이 유도의 요점이다.
 */
function accountWires() {
    const src = read("packages/core/src/accountState.ts");
    const body = src.slice(src.indexOf("export const ACCOUNT_SCOPED"), src.indexOf("export type AccountScoped"));

    // ⚠ **항목 블록으로 자른 뒤 필드를 따로 읽는다.** 한 정규식으로 세 필드를 이어 읽으면
    //    lazy 매칭이 **항목 경계를 넘어** 두 항목을 하나로 삼킨다 — 필드 순서만 바꿔도 그렇게 된다
    //    (심의 실증: `{what, enforcedBy, why}` 로 뒤집자 유도가 4→3 이 되고, 하필 빠진 것이
    //    `clearTenantSetting()` 이라 그 호출을 지워도 전 검사가 초록이었다).
    const blocks = body.split(/\n\s*\{/).slice(1);
    const field = (block, name) => {
        // 문자열 리터럴 하나를 통째로 — 이스케이프된 따옴표를 포함한다.
        const m = new RegExp(`${name}:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(block);
        return m ? m[1] : null;
    };
    const out = [];
    for (const block of blocks) {
        const what = field(block, "what");
        const why = field(block, "why");
        const enforcedBy = field(block, "enforcedBy");
        if (what === null && why === null && enforcedBy === null) continue; // 항목이 아닌 조각
        if (what === null || why === null || enforcedBy === null) {
            console.error(`✗ 계정 자리 항목에 빠진 필드가 있습니다(통과가 아닙니다): ${block.slice(0, 60).trim()}…`);
            process.exit(2);
        }
        // 목록은 JS 문자열이라 `\"` 로 이스케이프돼 있다 — 실제 소스에서 찾을 형태로 되돌린다.
        out.push(["packages/vscode/src/extension.ts", enforcedBy.replace(/\\"/g, '"'), `로그아웃이 ${what} 를 안 지운다 — ${why}`]);
    }

    // ⚠ **부분 판독을 무경보로 넘기지 않는다.** `out.length === 0` 만 보면 **일부만** 읽힌 경우가
    //    조용히 지나가고, 그때 잃은 자리는 아무도 안 지킨다. 목록이 스스로 선언한 개수와 맞춘다.
    const declared = (body.match(/\bwhat:\s*"/g) ?? []).length;
    if (declared === 0 || out.length !== declared) {
        console.error(
            `✗ 계정 자리 유도가 ${out.length}건인데 목록은 ${declared}건입니다(통과가 아닙니다) — ` +
                "accountState.ts 의 형태를 확인하십시오.",
        );
        process.exit(2);
    }
    return out;
}

WIRES.push(...accountWires());

const problems = [];
for (const [pattern, shape, instead] of BANS) {
    const dir = join(root, dirname(pattern));
    const suffix = basename(pattern).replace(/^\*/, "");
    const files = readdirSync(dir).filter((f) => f.endsWith(suffix));
    if (files.length === 0) {
        console.error(`✗ 금지 검사 — ${pattern} 에 해당하는 파일이 0개입니다(통과가 아닙니다).`);
        process.exit(2);
    }
    for (const file of files) {
        const rel = `${dirname(pattern)}/${file}`;
        if (shape.test(read(rel))) {
            problems.push(`${rel}: 비켜 가는 길이 열렸다 — ${shape}\n    → 대신 ${instead}`);
        }
    }
}
/** 겹치지 않는 등장 횟수. `includes` 는 **하나만 있으면 참**이라 나머지를 못 지킨다. */
function countOccurrences(haystack, needle) {
    let n = 0;
    for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) n += 1;
    return n;
}

for (const [file, needle, why, times = 1] of WIRES) {
    // ⚠ **존재가 아니라 횟수를 센다.** 같은 조각이 두 자리에 있으면 `includes` 는 **하나를 지워도**
    //    참이다 — 심의 실증: `if (previewGuard.busy)` 가 signOut·미리보기시작 두 곳에 있어, 로그아웃
    //    쪽을 `if (false)` 로 바꿔도 이 검사기가 초록이었다. 그 자리는 배송 문서가
    //    「준비하는 동안에는 로그아웃과 초기화가 잠시 거절됩니다」라고 약속한 바로 그 자리다.
    //
    //    많아지는 것도 반려다. 같은 판정이 두 벌이 되면 한쪽만 고쳐진다 — 이 레포가 반복해서 겪은 병이다.
    const got = countOccurrences(read(file), needle);
    if (got === times) continue;
    problems.push(
        got === 0
            ? `${file}: 배선이 없다 — ${needle}\n    → ${why}`
            : `${file}: 배선이 ${got}자리다(기대 ${times}) — ${needle}\n    → ${why}`,
    );
}

if (problems.length > 0) {
    for (const p of problems) console.error(`✗ ${p}`);
    console.error("");
    console.error("  형태를 바꾸셨다면 이 검사기의 목록도 같이 고치십시오 — 조용히 통과하는 쪽이 훨씬 나쁩니다.");
    process.exit(1);
}
console.log(`✓ 배선 검사 — ${WIRES.length}자리가 제자리에 있고 금지 ${BANS.length}종이 안 쓰였다(계정 자리 ${accountWires().length}은 목록에서 유도)`);
