# 설계 메모 — 로컬 소스 폴더의 사이트 소속(binding)

> 실사용 신고: 여러 사이트를 관리하는 계정이 x 사이트 소스 폴더를 연 채 사이트를 y 로 바꾸면,
> 폴더 전환 제안이 없고 소스 폴더는 기존 것을 계속 바라본다. 그 상태에서 미리보기는 y 자격증명을
> x 폴더의 `.env.local` 에 쓰고, 발행은 x 소스를 y 사이트로 올린다 — 양방향 교차 오염이다.

---

## 0. 결론 요약

**정책 한 줄**: 폴더는 한 사이트에 속하고 그 소속의 정본은 폴더 안 표식(`.zalkera/source.json`)이다.
창의 작업 사이트는 열린 폴더의 소속을 따르고, 다른 사이트를 고르는 것은 **폴더(창)를 옮기는 제안**으로
이어진다. 소속 변경은 명시적 「폴더 연결」(동의 모달)로만 한다.

| 초안 항목 | 판정 | 형상 |
|---|---|---|
| ① 게이트에 표식 대조 + 새 차단 사유 | **채택(형상 수정)** | 판정은 `siteDir()` 확장이 아니라 core `whyBlocked.ts` 의 새 요건 `siteMatches`. 함수는 `decideBlocked` 로 개명해 소독 정본 경로에 태운다(§4.2) |
| ② 사이트 선택 뒤 폴더 제안 | **채택** | `decideSiteChoice`(core 순수 판정) + 레지스트리 확증 + 받기는 `openSite(pinned)`(§4.4) |
| ③ 사이트→로컬본 레지스트리 | **채택(캐시로만)** | `globalState`, `ACCOUNT_SCOPED` 등재 필수. 정본이 아니며 제안 전 표식으로 확증한다(§4.4) |
| ④ `saveTenant` 가 남의 폴더 링크를 안 덮음 | **채택(확장)** | 표식뿐 아니라 워크스페이스 링크와도 대조. 범위 판정은 core `decideTenantScope`(§4.3) |
| ⑤ 디스크 배치 규약 `~/zalkera/<코드>/` | **기각** | 레지스트리가 편익을 대체. 강제 배치는 기존 폴더 이행 문제·OS별 함정·소스 소유 원칙과 충돌(§2) |

- **`@zalkera/client` 변경: 불필요.** examples(시작 소스 팩) 변경: **불필요**. 근거 §7.
- **판 등급: minor**(0.2.3 기준 다음은 0.3.0). 근거 §8.
- 미해결 쟁점(심의 회부): §10.

---

## 1. 현 상태 (코드 사실)

폴더가 사이트를 가리키는 자리가 **네 곳**이고, 서로 대조하는 곳이 없다.

| 자리 | 쓰는 코드 | 성격 |
|---|---|---|
| `.zalkera/source.json` | `core/src/localMark.ts` `writeSourceMarkTo` — 받기(`openSite`)가 쓴다 | 출처 사실(tenant·revisionNo·sha256·fetchedAt) |
| `.vscode/settings.json` 의 `zalkera.tenant` | `linkFolderToTenant`(받기 직후) 와 `saveTenant`(사이트 선택·폴더 연결) | 소속 의도 — 그런데 사이트 선택이 이 자리를 덮는다 |
| `.env.local` 의 `ZALKERA_TENANT`·`ZALKERA_STOREFRONT_KEY` | `core/src/env.ts` `writePreviewEnv` — 미리보기 시작이 쓴다 | 발급 자격증명(서버 TTL 최대 12시간 — `accountState.ts`) |
| `.mcp.json` 의 서버 URL(`{tenantCode}` 치환) | `connectAgent` → `core/src/mcp.ts` | 에이전트가 붙을 사이트 |

- `siteDir()`(extension.ts)은 `package.json` 존재만 본다. 표식은 받기 대상 제안
  (`chooseFetchTarget` 의 `holdsSameRevision`)에만 쓰인다.
- `chooseSite()` → `chooseTenant(true)` → `saveTenant(picked.code)` → `configTarget()` 은 폴더가
  열려 있으면 Workspace 범위 — **열린 폴더의 링크를 덮는다.** 신고된 결함의 기제다.
- `.zalkera/source.json` 보호 실측:
  - 업로드 zip 제외: 있음 — `core/src/zip.ts` 의 `EXCLUDED_PATHS`(경로 단위, 소문자 비교).
    재현: `grep -n "EXCLUDED_PATHS" packages/core/src/zip.ts`
  - git ignore: 확장은 보장하지 않는다(`project.ts` 의 `ensureEnvIgnored` 는 `.env.local` 만).
    examples 레포의 `.gitignore` 에는 그 줄이 있고 팩 zip 에 실려 나간다. 판정은 §6.3.
- 계정 전환 결함의 선례와 그 방어: `ACCOUNT_SCOPED`(`core/src/accountState.ts`)의 `enforcedBy`
  조각을 `scripts/check-wiring.mjs` 가 횟수까지 세어 집행한다. 새 계정범위 자료는 여기 등재해야 한다.

---

## 2. 정책과 대안 검토

**채택 정책**: 사이트 하나 = 폴더 하나 = 창 하나. 폴더의 표식이 소속의 정본이고, 사이트 전환은
폴더 전환이다. 초안 정책을 채택하되, 「소속」과 「출처」를 §4.1 처럼 갈라 적는다.

기각한 대안과 사유:

- **멀티루트 워크스페이스(한 창에 사이트별 루트 여러 개)** — 기각.
  ⑴ 이 확장의 창 단위 자원이 단수다: `session`(dev 서버)·`issuedKey`·상태바·사이드바·출력 채널.
  루트마다 사이트가 다르면 명령마다 「어느 루트냐」 분기가 붙고, 그 분기 하나하나가 교차 오염의
  새 표면이다. ⑵ `CapturedTenant` 규율이 (tenant, folder) 쌍으로 넓어져 캡처 지점 단일화가 무너진다.
  ⑶ VS Code 의 워크스페이스 범위 설정이 멀티루트에서는 `.code-workspace` 파일로 가서, 폴더와 함께
  이동하는 링크라는 전제가 깨진다. 잘못 고른 대가가 교차 테넌트 발행인 도구에서, 창 하나에 사이트
  하나가 곧 보안 경계다.
- **`.vscode/settings.json` 단독 정본(표식 없이) + 쓰기 범위만 교정** — 기각.
  settings 는 이번 사고에서 덮인 바로 그 자리라, 남은 값이 사고의 결과인지 의도인지 구분할 근거가
  파일 안에 없다. 그리고 업로드 zip 이 `.vscode` 를 통째로 빼므로(zip.ts) 정본 왕복에서 소실된다 —
  표식은 받기가 다시 써 주지만 링크는 아니다.
- **`globalState` 레지스트리를 소속의 정본으로** — 기각(캐시로만 채택).
  폴더와 함께 이동하지 않는다(경로 변경·다른 기계에서 소실)·사용자에게 보이지 않아 어긋났을 때
  물어볼 실물이 없다.
- **전환 시 `.env.local` 즉시 청소** — 기각. §6.2 — 게이트가 원인을 제거하고, 잔존은 TTL·다음
  미리보기 덮어쓰기·로그아웃 제거의 세 겹이 거둔다. 사용자 제스처 없는 파일 변조를 늘리지 않는다.
- **활성화 시 자동 복원(표식대로 settings 재작성)** — 기각. 필드에는 이번 사고로 이미 어긋난
  폴더가 있는데, 제스처 없는 쓰기로 그것을 고치기 시작하면 「도구가 내 설정을 마음대로 바꾼다」가
  된다. 복원은 사람의 제스처로만 한다 — 게이트 버튼의 전용 명령(§4.2) 또는 「사이트 선택」에서
  그 폴더의 사이트를 다시 고르기(§4.3).

---

## 3. 신뢰 서열 — 표식과 settings 가 어긋나면 누가 이기는가

**표식 > 워크스페이스 링크(`zalkera.tenant`) > 전역 설정.**

근거:

1. 표식은 받기·발행이라는 **실제 사건의 기록**이고 도구만 쓰는 것이 원칙이다. 링크는 오늘까지
   사이트 선택이 곁다리로 덮던 자리다 — 어긋남의 사고 모드가 「링크가 덮였다」이므로, 어긋났을 때
   진실은 표식 쪽이다.
2. 이 설계에서 **동의 경로(「폴더 연결」)는 표식과 링크를 같이 갱신한다**(§4.5). 그래서 남는
   어긋남은 사고(구판 결함의 잔재·손 편집 실수)로 간주해도 된다 — 의도된 어긋남을 만들 정규
   경로가 없다.
3. 표식을 손으로 고친 경우: 폴더는 고객 소유물이므로 그 값을 따른다. 이 서열은 자기 실수 방지
   장치이지 서버에 대한 신뢰 경계가 아니다 — 접근 권한은 서버가 판정하고, 사람 쪽 최종 방어선은
   사이트 이름을 박은 발행 확인 모달(`say.publishConfirm`)이다.

어긋남을 만난 게이트는 막고 말한다(§4.2). 링크 복원 경로는 둘이고 같은 곳에 닿는다: 게이트
버튼의 전용 명령 `zalkera.site.useFolder`(표식의 tenant 로 워크스페이스 링크를 되돌린다, §4.2)와,
「사이트 선택」에서 표식의 사이트를 다시 고르는 것(`decideTenantScope` 가 워크스페이스 쓰기로
판정한다, §4.3 셋째 행).

---

## 4. 형상 설계

### 4.1 표식 format 2 — 소속과 출처를 한 파일에서

`core/src/localMark.ts` 의 `SourceMark` 를 판별 유니온으로 넓힌다. 경로는 그대로
`.zalkera/source.json` — zip 제외(`EXCLUDED_PATHS`)·examples `.gitignore` 줄이 그대로 유효하다.

```ts
type SourceMark =
    | { format: 1; tenant: string; revisionNo: number; sha256: string; fetchedAt: string }   // 받기(현행 그대로)
    | { format: 2; origin: "published"; tenant: string; revisionNo: number; publishedAt: string }
    | { format: 2; origin: "linked"; tenant: string; linkedAt: string };
```

- **받기는 계속 format 1 을 쓴다.** 구판 확장의 `parseSourceMark` 는 `format !== 1` 을 null(「모른다」)로
  다루므로, 가장 흔한 경로에서 구판과의 회귀가 없다. format 2 는 구판에서 「모른다」로 강하한다 —
  막는 것도 없고 거짓 확신도 없다.
- `published`: 발행 성공 직후 그 폴더에 쓴다(§4.6). sha256 칸이 없다 — 업로드 zip 의 지문은 정본
  tar 의 지문과 다른 물건이라, 같은 칸에 넣으면 칸의 뜻이 거짓이 된다.
- `linked`: 명시 재연결(§4.5)이 쓴다. 판 주장을 하지 않는다.
- `parseSourceMark`: format 1·2 를 받고 그 밖은 null. `holdsSameRevision`: `linked` 는 항상 false
  (판 칸이 없다). `published` 를 「이미 받아 두셨습니다」 제안에 쓸지는 미해결 쟁점(§10) — 초판은
  format 1 만 제안에 쓰고, 게이트(§4.2)는 세 형상의 `tenant` 를 모두 본다.
- 재연결이 기존 표식을 덮으면 받기 출처 정보는 사라진다 — 의도된 동작이다. 재연결 뒤의 그 폴더에
  대해 「x 의 13판을 받아 둔 곳」 제안이 계속 나오는 쪽이 거짓이다.

### 4.2 게이트 — core `whyBlocked.ts` 의 새 요건 `siteMatches`

- `Readiness` 에 `folderTenant: string | null` 을 더한다 — 열린 폴더의 표식 tenant(없으면 null).
  확장은 `announceIfBlocked` 와 `refreshSidebar` 두 자리에서 `readSourceMarkAt(dir)` 로 읽어 넘긴다
  (사이드바와 게이트가 같은 값을 봐야 한다는 기존 규율 그대로 — `check-wiring` 에 횟수 2 로 박는다).
- `NEEDS` 에 넷째 요건 `"siteMatches"` 를 더해 다음 명령에 단다:
  `preview.start`·`preview.restart`·`agent.connect`·`precheck`·`publish`.
  **`site.link` 와 `site.useFolder` 에는 달지 않는다** — 재연결과 복귀가 곧 이 상태의 정규
  탈출구라, 달면 고리가 된다(whyBlocked.test 의 무한 고리 시험이 지키는 성질이다).
  `preview.stop` 은 지금처럼 요건이 없다.
- 판정: `folderTenant !== null && tenant !== "" && site !== null && folderTenant !== tenant` 일 때만
  막는다. **표식이 없으면 아무것도 막지 않는다** — localMark.ts 의 「부재는 정상이다」 규율 그대로다.
- 차단 문면(사이트 코드 노출과 소독): 표식 tenant 와 고른 tenant 는 폴더·서버가 정한 값이라 비-모달
  알림에서 링크 렌더 표면이다. 그래서:
  - 함수를 `decideBlocked` 로 개명한다. `check-notice.mjs` 의 정본 판정(`decide[A-Z]` + 정본 모듈
    import)에 걸려, 호출부가 `blocked.message` 를 그대로 보여 줄 수 있다.
    `announceIfBlocked` 의 `ours(blocked.message)` 는 `blocked.message` 로 바꾼다 — 서버 유래 값이
    든 문장에 `ours` 표기를 남기면 표기가 거짓이 된다.
  - `whyBlocked.ts` 를 `check-notice.mjs` 의 `NOTICE_SOURCES` 에 올려 템플릿 전수 검사를 받게 하고,
    보간 자리는 `plainNotice(code, 64)` 를 지나게 한다. 기존 세 문면은 리터럴 그대로 남는다.
  - 문면(비-모달은 한 줄로 잘리므로 문장 하나만 — 복원·대안 경로는 문장이 아니라 버튼이 나른다.
    버튼은 잘리지 않는다): `이 폴더는 「x」 사이트의 소스입니다 — 「y」 작업은 그 사이트의 폴더에서
    해 주세요.` 행동 버튼 둘(라벨은 리터럴 — 서버 값 소독 문제를 버튼에서 만들지 않는다):
    - `{label: "이 폴더의 사이트로 돌아가기", command: "zalkera.site.useFolder"}` — 이 상태에
      빠진 사람이 대개 원하는 것(이 폴더에서 그대로 계속하기)을 한 번에 준다. 표식의 tenant 를
      읽어 워크스페이스 범위 링크를 그 값으로 되돌린다. §4.5 의 「폴더 연결」과 달리 **소속을
      바꾸지 않고 링크만 소속에 맞추므로** 동의 모달이 없다. 표식이 그 사이 사라졌으면 알림만
      하고 아무것도 쓰지 않는다.
    - `{label: "그 사이트 소스 받기", command: "zalkera.site.open"}` — site.open 의 요건은
      `signedIn`·`tenant` 라 이 상태에서 막히지 않는다.
  - `zalkera.site.useFolder` 의 고정: `NEEDS` 에 빈 요건으로 등재한다(`preview.stop` 과 같은
    형상 — 탈출구라 어떤 요건도 어긋난 폴더에서 이 명령을 막게 하면 안 된다). whyBlocked.test 의
    무한 고리 시험을 이 명령까지 확장한다(차단의 action 명령이 스스로 막히면 고리).
    `check-wiring.mjs` 에는 등록부 `register("zalkera.site.useFolder", ...)` 줄, 게이트 action
    배선, 워크스페이스 범위 쓰기 줄을 박는다.
- `siteDir()` 은 손대지 않는다. 「폴더가 소스인가」와 「소스가 이 사이트 것인가」는 다른 축이고,
  한 함수에 합치면 사이드바의 「소스 없음」 표시와 뒤섞인다. 사이드바에는 `SidebarState.folderTenant`
  를 더해, 어긋난 폴더에서 info 항목 「⚠ 이 폴더는 「x」 의 소스」 를 그린다(`sidebarPlan.ts` 판정,
  시험이 문다).

### 4.3 쓰기 범위 — `saveTenant` 는 남의 폴더 링크를 덮지 않는다

core 에 순수 판정을 둔다(새 파일 `core/src/siteBinding.ts` 권고 — 확장 안에 두면 시험·검사기가
못 닿는다는 이 레포의 형상 그대로):

```ts
/** 폴더의 소속. 표식이 이기고, 없으면 워크스페이스 링크다(§3 서열). */
function folderBinding(mark: SourceMark | null, linkedTenant: string | null): string | null;

/** 사이트 선택이 어느 범위에 적을지. */
function decideTenantScope(input: {
    siteFolderOpen: boolean;          // siteDir() !== null
    binding: string | null;           // folderBinding(...)
    chosen: string;
}): "workspace" | "global" | "none";
```

판정표:

| 상태 | 범위 | 뜻 |
|---|---|---|
| 폴더 없음 / 소스 아닌 폴더 | global | 창의 작업 사이트만 바뀐다. 소스 아닌 폴더에 `.vscode` 를 만들어 주지 않는다 |
| 소스 폴더 · 소속 없음 | workspace | 폴더가 그 사이트를 입양한다(오늘의 동작 유지 — 이행 §5). 알림에 「이 폴더를 「y」 에 연결했습니다」 를 명시한다 |
| 소속 == 고른 사이트 | workspace | 재확인이자, 어긋났던 링크의 복원 경로다(§3) |
| 소속 != 고른 사이트 | none | **아무것도 적지 않는다** — 폴더 링크도, 전역도. 이어서 §4.4 의 제안 흐름 |

확장의 `saveTenant` 는 이 판정을 지나 `configTarget()` 직접 호출을 대체한다 — `none` 이면 어떤
범위에도 쓰지 않는다. `linkFolderToTenant`
(받기 직후)와 「폴더 연결」의 동의 경로(§4.5)는 이 판정을 지나지 않는다 — 그 둘은 소속을 **정하는**
쓰기라 워크스페이스 범위가 본령이다. 워크스페이스 링크 읽기는
`getConfiguration("zalkera").inspect("tenant")?.workspaceValue` 로 한다 — 병합 조회로는 전역 값과
구분할 수 없다.

넷째 행이 전역 쓰기가 아니라 무기록인 이유: 전역에 y 를 적으면 그 값은 이 창에서는 죽은 값이면서
(병합 조회는 워크스페이스가 이긴다), **표식도 워크스페이스 링크도 없는 다음 폴더**(§5 셋째 행 —
구판 받기·타 입구)를 여는 순간 그 창의 유효 사이트가 된다. 그런 폴더에는 표식이 없어 §4.2 게이트가
서지 않으므로, 이 설계가 막으려는 교차 업로드가 한 다리 건너 재현된다. 오늘은 `saveTenant` 가
폴더 열린 창에서 워크스페이스로만 써서 전역이 잘 오염되지 않는데, 전역 쓰기는 그 노출을 흔한
흐름에서 새로 만드는 변경이다. 그리고 전역 쓰기의 편익을 찾지 못했다 — 세 갈래 모두 전역 없이
완결된다: 「폴더 열기」는 그 폴더의 워크스페이스 링크가 창을 y 로 만들고, 「소스 받기」는
`captureTenant(picked.code)` 로 잡은 pinned 를 쓰며(§4.4), 취소는 상태를 바꾸지 않는 것이 정직하다.

주의할 동작 변화: 소속이 다른 폴더에서 고른 사이트는 어디에도 적히지 않으므로, 그 창의 유효 사이트
(`tenantCode()` 병합 조회)는 폴더 것에 머문다. 그래서 `chooseSite` 는 「y 로 바꿨습니다」라고
말하면 안 되고 §4.4 의 제안으로 넘어가야 한다 — 화면이 실제와 갈리는 문장을 만들지 않는다.

### 4.4 사이트 선택 뒤의 제안 흐름과 레지스트리

core 판정:

```ts
type SiteChoice =
    | { kind: "switched" }                                  // 폴더 없음·소속 없음·같은 사이트 — 오늘처럼 진행
    | { kind: "adopted" }                                   // 소속 없던 소스 폴더가 입양됨 — 연결 사실을 알린다
    | { kind: "elsewhere"; offer: "open" | "fetch" };       // 소속이 다르다 — 폴더 전환 제안

function decideSiteChoice(input: {
    picked: string;
    binding: string | null;
    siteFolderOpen: boolean;
    /** 레지스트리가 기억하는 그 사이트의 폴더 — 호출 전에 확증까지 끝낸 값만 넣는다. */
    knownFolderConfirmed: boolean;
}): SiteChoice;
```

- `elsewhere` 의 화면(문구는 `tenantScope.ts` 의 `say` 에 추가 — 소독 정본 자리):
  `「y」 를 고르셨습니다. 이 폴더는 「x」 의 소스라서, 「y」 작업은 다른 폴더에서 합니다.`
  버튼은 리터럴로 둔다(서버 값 소독 문제를 버튼에서 만들지 않는다):
  - 레지스트리가 y 의 폴더를 알고 확증되면 「그 사이트 폴더 열기」 → `vscode.openFolder`(같은 창).
    열린 폴더의 워크스페이스 링크가 창을 y 로 만든다.
  - 모르면 「그 사이트 소스 받기」 → `withReceiveGuard(() => openSite(pinned))`. 받기는 새 빈
    폴더로만 가므로(`fetchSiteSource`) 지금 폴더는 손대지 않는다.
- **`openSite(pinned?: CapturedTenant)`**: 이 흐름에서는 창의 유효 사이트가 여전히 x 라
  `ensureApiFor()` 의 기본 경로가 x 를 잡는다. 고른 y 를 `captureTenant(picked.code)` 로 잡아
  넘긴다 — `check-capture-tenant.mjs` 의 EXPECTED 를 1→2 로 올리고 커밋에 사유를 적는다
  (고르는 그 순간이 이 값이 API 에 묶일 값으로 고정되는 순간이다). 등록부의
  `register("zalkera.site.open", () => withReceiveGuard(openSite))` 줄은 그대로다(배선 검사 유지).
- **레지스트리**: `globalState` 키 `zalkera.folderRegistry` — `사이트 코드 → 마지막 로컬본 절대경로`.
  - 쓰는 곳: 받기 성공(`openSite` 의 root)·발행 성공·「폴더 연결」 성공.
  - **정본이 아니다.** 제안 전에 반드시 확증한다: 폴더가 실재하고, 그 폴더의
    `folderBinding`(표식 우선)이 고른 사이트와 같을 때만 「열기」를 제안한다. 어긋나면 항목을
    버리고 「받기」로 간다 — 경로가 재활용돼 다른 사이트를 담게 된 폴더를 열어 주는 것이
    이 설계가 막으려는 바로 그 사고다.
  - **계정범위 자료다.** `ACCOUNT_SCOPED` 에 등재한다:
    `{ what: "folderRegistry", why: "남기면 다음 계정에게 앞사람의 사이트 코드와 로컬 폴더 경로가 보이고, 그 폴더를 열도록 제안한다", enforcedBy: "await clearFolderRegistry();" }`
    — `check-wiring.mjs` 의 자동 유도가 `signOut` 의 그 호출을 강제한다. 지우는 순서는
    `clearTenantSetting()` 다음(실패해도 다음이 도는 순서 규율 그대로).

### 4.5 명시 재연결 — 「폴더 연결」(B3, `linkFolder`)만이 소속을 바꾼다

- 폴더에 소속이 있고 고른 사이트와 다르면 **모달 동의**를 받는다(문구는 `say`):
  `이 폴더는 「x」 의 소스입니다. 「y」 로 다시 연결하면, 이 폴더의 소스가 「y」 사이트로 올라가게 됩니다.`
  확인 시: ⑴ 워크스페이스 링크 쓰기(범위 판정 우회 — 소속을 정하는 쓰기다)
  ⑵ 표식을 `{format: 2, origin: "linked", tenant: y, linkedAt}` 로 덮어쓰기
  ⑶ 레지스트리 갱신 ⑷ 사이드바 갱신(기존).
- 이 경로가 표식과 링크를 같이 쓰기 때문에 §3 의 「어긋남은 사고다」가 성립한다.
- 동의 판정(모달을 띄울지 말지)은 core 순수 함수로 둔다 — 확장 안 조건문은 시험이 못 문다.

### 4.6 발행이 소속을 결정화한다

발행 성공 직후, 그 폴더에 `{format: 2, origin: "published", tenant, revisionNo, publishedAt}` 를
쓴다(`writeSourceMarkTo` 재사용 — 실패는 로그만, 발행을 실패로 만들지 않는다: 받기와 같은 규율).

- 표식 있는 폴더의 발행은 게이트가 소속 일치를 이미 강제하므로 tenant 가 갈릴 수 없다. 표식 없는
  폴더(프리셋 시작·구판 받기·타 입구)의 발행은 사이트 이름을 박은 확인 모달을 지난 사람의 결정이고,
  그 순간이 이 폴더의 소속이 처음으로 사실이 되는 순간이다 — 여기서 결정화하는 것이 이행(§5)의
  기둥이다.
- 예제로 시작(`startFromExample`)은 표식을 쓰지 않는다 — 그 시점의 폴더는 어느 사이트의 소스도
  아니다.
- **받기와 발행은 동의의 성격이 다르다**: 받기의 표식은 사용자가 대상으로 고른 폴더에 생기지만,
  발행의 표식은 사용자가 파일 생성을 고른 적 없는 폴더에 부수효과로 생긴다 — BYO git 레포라면
  커밋 대상이 된다. 그럼에도 쓰는 근거는 §6.3(표식은 비밀이 아니고, git 레인에서는 커밋된 표식이
  소속을 실어 나르는 이점)이다. 이 차이는 심의 대상으로 남긴다(§10).

---

## 5. 이행 — 표식 없는 기존 폴더

원칙: **표식의 부재로는 아무것도 막지 않는다**(localMark.ts 의 기존 규율). 막으면 구판으로 받은
사용자 전원이 멈춘다.

| 기존 폴더 상태 | 이 설계에서의 취급 |
|---|---|
| 표식 있음(현행 확장으로 받음) | 즉시 보호된다 — 게이트·쓰기 범위·제안이 전부 선다 |
| 표식 없음 · 워크스페이스 링크 있음 | 게이트는 못 지키지만(표식 기준), 링크가 `folderBinding` 의 둘째 근거라 쓰기 범위(§4.3)와 제안 흐름(§4.4)은 지켜진다 — 사이트 선택이 이 폴더를 덮는 일은 사라진다 |
| 둘 다 없음(구판 받기·타 입구) | 오늘과 같다: 사이트를 고르면 입양된다(워크스페이스 쓰기 + 연결 알림). 잔여 위험은 발행 확인 모달이 막는다 |
| 어긋난 폴더(이번 사고의 잔재: 표식 x·링크 y) | 게이트가 막고 복원 버튼을 준다(§4.2). 「이 폴더의 사이트로 돌아가기」 또는 「사이트 선택」에서 x 재선택으로 링크가 복원된다(§4.3 셋째 행) |

결정화(표식이 생기는 길) 셋: 받기(format 1)·발행(§4.6)·명시 재연결(§4.5). settings 링크를 근거로
표식을 자동 백필하는 안은 기각 — 필드의 링크에는 이번 사고로 덮인 값이 섞여 있어, 자동 백필은
오염을 진실로 굳힌다.

구판 확장과의 공존: format 2 표식을 구판이 읽으면 `parseSourceMark` 가 null(「모른다」)로 강하한다.
받기는 format 1 을 유지하므로 구판의 「이미 받아 두셨습니다」 제안도 그대로 돈다.

---

## 6. 보안 판정

### 6.1 막는 것

- x 폴더에 y 미리보기 자격증명 주입(`.env.local`) — `preview.start/restart` 게이트.
- x 소스의 y 사이트 발행(교차 테넌트 업로드) — `publish` 게이트.
- x 폴더에 y 의 에이전트 접속 주소(`.mcp.json`) — `agent.connect` 게이트.
- 사이트 선택이 폴더 링크를 조용히 덮는 것 — 쓰기 범위 판정.
- 전역 오염을 통한 우회 — 소속이 다른 폴더에서 고른 사이트가 전역에 남았다가, 표식·링크 없는
  다음 폴더의 유효 사이트가 되어 게이트 없이 발행되는 것 — 쓰기 범위 판정 넷째 행의 무기록(§4.3).
- 로그아웃 뒤 다음 계정에게 앞 계정의 사이트 코드·폴더 경로가 제안되는 것 — 레지스트리의
  `ACCOUNT_SCOPED` 등재.

### 6.2 `.env.local` 에 이미 남아 있는 다른 사이트의 자격증명

전환 시 능동 삭제는 하지 않는다. 근거:

- 이 설계로 「y 키가 x 폴더에 쓰이는」 신규 발생 자체가 게이트에서 사라진다.
- 이미 남은 키는 세 겹이 거둔다: ⑴ 서버 TTL 최대 12시간(`accountState.ts` 기재)
  ⑵ 다음 미리보기가 관리 칸을 그 폴더의 사이트 값으로 덮어쓴다(`mergeEnv` — 중복 줄 제거 포함)
  ⑶ 로그아웃·초기화가 키 줄을 지운다(`stripCredentials`, 배선 집행 중).
- 어긋남을 감지한 시점은 「막고 말하는」 시점이지 파일을 고칠 제스처가 아니다. 그 순간 그 폴더의
  키가 지금도 유효한 제 것일 수 있어, 지우는 쪽이 새 고장을 만든다.

잔존 `ZALKERA_TENANT` 줄은 자격증명이 아니고 다음 미리보기가 갱신한다.

### 6.3 못 막는 것 (정직하게 적는다)

- **표식 없는 폴더의 교차 오염** — 결정화 전에는 게이트가 설 근거가 없다. 방어선은 발행 확인
  모달(사이트 이름 명시)과 §5 의 결정화 경로다.
- **폴더 내용물의 적대성** — dev 서버는 그 폴더의 코드를 실행한다. 이 도구가 이미 전제하는
  위협(zip 은 언제나 적대적일 수 있다 — `npmBlindSpots` 의 근거)이고, 이 변경과 무관하게 남는다.
  git 레인으로 유통된 레포가 남의 표식·링크를 담고 있으면 게이트는 그 사이트 작업을 막는 쪽으로
  동작한다(fail-safe) — 제 사이트로 쓰려면 「폴더 연결」 재연결을 지난다.
- **표식·settings 의 손 편집** — 폴더는 고객 소유라 막지 않는다. 서버 권한 판정과 발행 모달이
  최종 경계다.
- **`.zalkera/source.json` 의 git 커밋(BYO 레포)** — 확장이 고객 `.gitignore` 에 줄을 추가하지
  않는 현행을 유지한다. 표식은 비밀이 아니고, git 레인에서는 커밋된 표식이 두 번째 기계에도
  소속을 실어 나르는 이점이 있다. 비용은 낡은 판 번호가 「이미 받음」 힌트를 흐리는 정도다.
  팩 계보 폴더는 팩의 `.gitignore` 가 이미 그 줄을 싣고 있다. 발행이 이 파일을 사용자가 고른
  자리 밖에 만든다는 점(받기와 동의 성격이 다르다)은 §4.6 에 명시했고 심의에 회부한다(§10).

---

## 7. `@zalkera/client` · 시작 소스 팩(examples) 판정

**둘 다 변경 불필요. 이번 건은 devtools 단독이고, 묶음 판올림이 필요 없다.**

- `@zalkera/client`: **불필요.** 폴더 소속은 편집기·확장의 관심사다. client 의 계약면은 런타임
  API 와 env 변수 이름(`ZALKERA_API_BASE`·`ZALKERA_TENANT`·`ZALKERA_STOREFRONT_KEY` 등)이고 이
  설계는 그것을 바꾸지 않는다. client 소스에 `.zalkera` 경로·`zalkera.tenant` 설정을 읽는 코드가
  없다. 재현: `grep -rn "zalkera\.tenant\|source\.json" zalkera-client/src` → 해당 참조 0건
  (걸리는 것은 baseUrl 예시 문자열뿐). `llms.txt` 도 손대지 않으므로 바이트 대조 판올림 사유가 없다.
- examples(시작 소스 팩): **불필요.**
  - 팩 zip 의 `.zalkera/` 는 명시 목록으로 조립된다(`scripts/pack-preset.mjs` — `seed.json`·
    `ASSETS-LICENSE.md`·`assets/`·`pack.json`). `source.json` 이 팩에 실릴 경로가 없고, 레포
    `.gitignore` 도 그 줄을 이미 갖고 있다. 재현:
    `grep -n "source.json" zalkera-storefront-examples/.gitignore zalkera-storefront-examples/scripts/pack-preset.mjs`
  - format 2 도 같은 경로를 쓰므로(§4.1) `.gitignore` 줄·`zip.ts` 제외가 그대로 유효하다.
  - `AGENTS.md` 는 소스 규약 문서라 폴더 소속 정책(도구 UX)이 들어갈 자리가 아니다.

---

## 8. 판 등급 — minor

`doc/RELEASE.md` §0 기준 「고객이 보던 것이 달라지는 변경」에 해당한다:

- 새 차단 알림이 뜬다(어긋난 폴더에서 미리보기·발행·에이전트 연결·검사) — 복귀 버튼
  「이 폴더의 사이트로 돌아가기」 포함.
- 사이트 선택의 흐름이 달라진다(소속 다른 폴더에서 폴더 전환 제안).
- 사이드바에 새 항목이 생긴다(소속 경고).
- 「폴더 연결」에 동의 모달이 생긴다.

따라서 **minor**. `packages/vscode/CHANGELOG.md` 에는 결과만 적는다(§5 규율): 무엇이 새로 막히고,
사이트를 바꾸면 무엇이 제안되는지.

---

## 9. 시험·검사기로 고정할 것

각 항목에 「이 시험이 없으면 무엇이 조용히 깨지는가」를 단다. 검사기·문면 시험은 변이로 깨뜨려
확인한다(구현 단계 의무).

| 고정 대상 | 자리 | 없으면 조용히 깨지는 것 |
|---|---|---|
| `parseSourceMark`: format 1 현행 유지 · format 2 두 형상 판독 · 미지 format→null · 필드 결손→null | `localMark.test.ts` | 파서 교체 실수 하나로 기존 표식 전체가 null 이 되어, 이미 보호되던 폴더의 게이트·제안이 소리 없이 꺼진다 |
| `holdsSameRevision`: `linked` 는 false | `localMark.test.ts` | 판 주장이 없는 표식에 「이미 받아 두셨습니다」가 거짓으로 뜬다 |
| `decideBlocked` 어긋남 분기: 대상 명령마다 막힘 · `site.link`·`site.useFolder` 는 안 막힘 · 표식 없음/tenant 빔/폴더 없음이면 안 막힘 · action 은 useFolder·site.open 둘 · 무한 고리 없음(기존 시험을 두 action 까지 확장) | `whyBlocked.test.ts` | ⑴ 게이트 분기를 통째로 지워도 전건 초록(교차 오염 복귀) ⑵ 조임 실수로 표식 없는 기존 사용자 전원이 막혀도 초록 ⑶ 재연결·복귀까지 막혀 탈출구가 사라져도 초록 |
| `site.useFolder`: `NEEDS` 빈 요건 — 어긋난 폴더에서 스스로 막히지 않음 | `whyBlocked.test.ts` | 탈출 명령에 요건이 붙어 복귀 버튼이 죽어도 초록 — 어긋난 폴더가 갇힌 상태가 된다 |
| 어긋남 문면의 보간 소독 | `check-notice.mjs` 의 `NOTICE_SOURCES` 에 `whyBlocked.ts` 등재. 확인: 맨 보간을 넣은 변이에 검사기가 서는지 | 폴더·서버가 정한 사이트 코드가 비-모달 알림의 링크 렌더 표면에 무소독으로 실린다 |
| `decideTenantScope` 판정표 네 행 전부(넷째 행은 무기록 `none`) | 새 `siteBinding.test.ts` | ⑴ 원 결함(사이트 선택이 폴더 링크를 덮는다)이 재발해도 전건 초록 — 이 설계의 존재 이유가 무너진다 ⑵ 넷째 행이 전역 쓰기로 퇴행해도 초록 — 교차 업로드가 무표식 폴더로 옮겨간다(§4.3·§6.1) |
| `folderBinding` 서열(표식 > 링크) | 같은 파일 | 서열이 뒤집혀도 초록 — 어긋난 폴더에서 링크(오염된 값)가 이겨 게이트가 눈을 감는다 |
| `decideSiteChoice`: 확증 실패 시 fetch 제안 · 확증 성공 시 open 제안 · 입양 시 연결 사실 알림 | 같은 파일 | 재활용된 경로(다른 사이트를 담게 된 폴더)를 「그 사이트 폴더」로 열어 준다 |
| 레지스트리의 계정범위 집행 | `ACCOUNT_SCOPED` 등재 → `check-wiring.mjs` 자동 유도(`enforcedBy: "await clearFolderRegistry();"`) | 로그아웃이 레지스트리를 안 지워, 다음 계정에 앞사람의 사이트 코드·폴더 경로가 제안된다 |
| 배선: ⑴ 게이트·사이드바가 `folderTenant` 를 공급받는 줄(횟수 2) ⑵ `saveTenant` 가 `decideTenantScope` 를 지나는 줄 ⑶ 발행 성공 후 표식 쓰기 줄 ⑷ 제안 흐름의 받기가 `withReceiveGuard` 를 지나는 줄 ⑸ `site.useFolder` 의 등록부 `register` 줄·게이트 action·워크스페이스 범위 쓰기 줄 | `check-wiring.mjs` WIRES 추가 | core 판정은 살아 있는데 확장이 안 부르는, 이 레포가 반복해서 겪은 그 형상 — 전건 초록인 채 게이트가 장식이 된다 |
| `captureTenant` 자리 수 | `check-capture-tenant.mjs` EXPECTED 1→2 + 커밋 사유 | 올리지 않으면 verify 가 서고(의도), 사유 없이 올리면 규율의 가시화가 죽는다 |
| zip 제외의 format 무관성 | 기존 `zip.test.ts` 가 경로 기준이라 그대로 덮는다 — 신규 시험 불요를 여기 명시 | (해당 없음 — 판정 기록) |
| 사이드바 소속 경고 항목 | `sidebarPlan.test.ts` | 리팩터링에서 경고 항목이 사라져도 초록 — 어긋난 폴더가 화면상 건강해 보인다 |

---

## 10. 미해결 쟁점 (심의 회부)

1. `published` 표식을 「이미 받아 두셨습니다」 제안에도 쓸지 — 발행 zip 과 정본 tar 는 제외 목록만큼
   내용이 다르다. 초판은 게이트에만 쓰는 안을 권고.
2. `captureTenant` EXPECTED 증가(1→2)의 심의 확인 — 검사기 머리말이 요구하는 절차다.
3. `chooseTenant` 안 SUPER_ADMIN 직접 입력 경로 — 쓰기 범위 판정 공유로 충분한지, 어긋남 제안까지
   태울지.
4. `linked` 표식이 받기 표식을 덮을 때 출처 정보 소실 — 본 메모는 의도된 동작으로 판정(§4.1).
   심의가 뒤집으면 format 2 에 선택 칸을 더하는 안이 후보다.
5. 발행의 표식 결정화(§4.6) — 사용자가 파일 생성을 고르지 않은 폴더에 커밋 대상 파일이 생긴다
   (받기와 동의 성격이 다르다). 본 메모는 §6.3 근거로 유지 판정. 심의가 뒤집으면 발행 확인 모달에
   표식 생성 사실을 명시하는 안이 후보다.
