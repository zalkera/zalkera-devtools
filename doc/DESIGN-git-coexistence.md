# 설계 메모 — git · GitHub 와 함께 쓰기: 확장은 git 을 모른 채로 맞물린다

> 오너 문제 제기: 소스의 버전 관리를 GitHub 로 하려면, 확장에 GitHub 연동을 넣는 대신
> VS Code 기본 Git(`vscode.git`) + GitHub Authentication + GitHub Pull Requests 확장에 맡기는
> 방향으로 간다. 그 위에서 잘커라 확장과 **끊김 없이** 돌게 할 수 있는가.

**상태: 제안 · 코드 미구현.** 문서 트랜치(T0)는 이 메모와 같은 판에 실린다. T1~T3 은 오너 결정 뒤
3축 심의를 거쳐 구현한다.

---

## 0. 결론 요약

**정책 한 줄**: 확장은 **git 명령을 실행하지 않고, GitHub 에 접속하지 않고, 커밋·푸시·태그를
스스로 만들지 않는다.** git 이 있는 폴더에서 확장이 하는 일은 셋뿐이다 — ⑴ 디스크가 바뀐 것을
**알아차리고**(재계산) ⑵ 되돌릴 수 없는 문 앞에서 git 상태를 **한 줄 읽어 주고** ⑶ 발행이 끝난
뒤 「이 커밋이 그 판」이라는 표식을 **사람이 원할 때만** 남긴다.

| 항목 | 판정 | 요지 |
|---|---|---|
| GitHub API·PAT·PR·이슈 | **안 짓는다** | VS Code 의 GitHub 확장이 이미 한다. 우리가 넣으면 토큰 보관·API 추종·권한이 우리 부채가 된다(§7) |
| git 명령 실행(커밋·푸시·stash) | **안 짓는다** | 제스처 없는 쓰기. 고객 레포는 고객 것이다 |
| 디스크 변화 감지(T1) | **채택** | 지금은 **저장할 때만** 판을 다시 센다. `git pull`·`checkout`·에이전트 쓰기 뒤에 사이드바가 낡은 「일치」를 사실로 그린다(§1) |
| 문 앞 git 한 줄(T2) | **채택** | 「서버 판으로 교체」·「zip 으로 교체」·「새 버전 배포」 확인 창에 `git: main @ 1a2b3c4 · 커밋하지 않은 변경 3개`. **막지 않는다** |
| 발행 뒤 태그(T3) | **오너 결정** | 성공 알림에 「git 태그 만들기」 단추. 확장이 고객 git 에 **쓰는 첫 자리**라 오너가 연다(§8) |
| `.zalkera/source.json` 을 `.git/info/exclude` 에(T1') | **채택** | CLI 가 `sync.json` 에 이미 쓰는 규칙과 같은 근거 — 커밋을 타고 넘어온 남의 기준점은 **거짓 상태**다(§5) |
| 교체 뒤 `.github/workflows/` 소실 | **문서 먼저** | 서버가 그 폴더를 저장하지 않아 「서버 판으로 교체」가 지운다. git 에 삭제로 뜬다(§1 ⑥). 보존은 손 목록이라 보류 |
| 판 ↔ 커밋 결속을 서버에 | **안 짓는다** | 접은 memo84 의 `commit_sha` 다. 결속은 git 태그(사람 것)로 충분하다 |
| git push → 자동 발행(Actions) | **안 짓는다(지금)** | CLI 에 헤드리스 자격이 없다(§1 ⑧). 만들면 장수 시크릿 축이라 별도 결정이다 |

⚠ **「끊김 없음」의 뜻을 좁게 잡는다.** 확장이 git 을 대신해 주는 것이 아니라, **git 이 한 일을
확장이 틀리게 말하지 않는 것**이다. 지금 어긋나는 자리는 셋이고(§1 ①②⑥) 그 셋만 닫는다.

---

## 1. 현 상태 (코드 사실)

① **판 재계산 트리거는 저장뿐이다.** `scheduleFolderVersion()` 을 부르는 자리는
`onDidSaveTextDocument` 하나이고, 파일 감시기는 없다.
재현: `grep -n "scheduleFolderVersion()" packages/vscode/src/extension.ts` → 호출 1건(저장 핸들러) + 정의 1건 ·
`grep -c createFileSystemWatcher packages/vscode/src/extension.ts` → 0.
그래서 `git pull`·`git checkout`·`git stash`·에이전트의 직접 쓰기 뒤에는 **다음 저장이나 명령까지**
사이드바 「버전」이 옛 결론을 그린다. 코드도 이 손을 안다 — 보호 경로 경고는 그래서 「열 때」도 본다
(`warnProtectedPath` KDoc). 판 재계산에는 그 둘째 갈래가 없다.

② **되돌릴 수 없는 세 문은 git 을 안 본다.** `say.serverReplaceConfirm`·`say.publishConfirm` 의
재료는 판 번호·폴더·남기는 이름·잔재다. 커밋하지 않은 변경이 있어도 아무 말이 없다.
재현: `grep -n "serverReplaceConfirm\|publishConfirm" packages/core/src/tenantScope.ts`.

③ **`.git` 은 이미 지킨다.** 포장기가 `.git` 을 뺀다(`zip.ts` 의 배제 목록). 「zip 으로 교체」·
「서버 판으로 교체」는 같은 술어로 남길 이름을 고르므로 `.git` 이 자리에 남는다(`keepNames`).
재현: `grep -n '"\.git"' packages/core/src/zip.ts` · `grep -n "isExcludedEntry" packages/core/src/replaceDir.ts`.

④ **`.env.local` 은 미리보기를 켤 때 `.gitignore` 에 보장한다** — `.git/` 이 있을 때만, 없으면
만들지 않는다(`ensureEnvIgnored`). 판정 축이 「`.gitignore` 가 있는가」에서 「`.git` 이 있는가」로
한 번 고쳐진 자리다(심의 차단 2026-08-03 · `git init` 직후 키가 커밋된 실측).
재현: `grep -n "ensureEnvIgnored" packages/core/src/preview.ts packages/core/src/project.ts`.

⑤ **CLI 의 동기화 장부(`.zalkera/sync.json`)는 `.git/info/exclude` 로 감춘다** — `.gitignore` 가
아니라. 근거는 `pull.ts` 의 `ignoreLedger` KDoc: `.gitignore` 는 판이 싣고 오는 파일이라 거기
한 줄을 붙이면 두 번째 받기부터 영구 충돌한다. **확장은 이 장부를 쓰지 않는다**(CLI 전용).
재현: `grep -rn "writeLedger" packages/*/src --include="*.ts" | grep -v test` → cli·core 만.

⑥ **서버는 `.github/workflows/` 를 저장하지 않는다**(`serverNormalization.ts` 의
`EXCLUDED_PREFIXES`). 시작 소스 팩은 `ci.yml`·`client-upgrade.yml` 둘을 싣고 온다. 그래서
「서버 판으로 교체」 뒤 그 둘이 폴더에서 사라지고, git 은 **삭제 두 건**으로 보인다.
재현: `grep -n "github/workflows" packages/core/src/serverNormalization.ts`.

⑦ **폴더 소속의 정본은 `.zalkera/source.json` 이고, 없으면 `.vscode/settings.json` 의
`zalkera.tenant`** 다(`siteBinding.ts` 의 `folderBinding`). 확장이 `settings.json` 에 쓰는 것은
그 한 키뿐이다(`mergeTenantSetting`). 둘 다 비밀이 아니다.
재현: `sed -n '20,24p' packages/core/src/siteBinding.ts`.

⑧ **CLI 는 브라우저 로그인 + 홈 폴더 파일 토큰뿐이다.** 환경변수로 받는 자격증명이 없다.
재현: `grep -n "process.env" packages/cli/src/*.ts | grep -v test` → 서버 주소 하나.
GitHub Actions 에서 `zalkera publish` 를 돌리려면 refresh 토큰을 시크릿에 넣어야 하고, 그것은
**전 권한 장수 자격증명**이다 — 이 메모의 범위 밖(§7).

⑨ **`vscode.git` 확장 API**(VS Code 동봉 · `extensions/git/src/api/git.d.ts` · 2026-09-14 조회):
`getExtension("vscode.git").exports.getAPI(1)` → `API.getRepository(uri)` → `Repository.state`
(`HEAD: Branch | undefined` · `workingTreeChanges` · `indexChanges` · `untrackedChanges` ·
`refs`) · `tag(name, message, ref?)` · `getRefs(query)` · `state.onDidChange`.
⚠ **`untrackedChanges` 는 설정(`git.untrackedChanges`)에 따라 비고 `workingTreeChanges` 에 섞여
온다.** 세 배열을 **합쳐** 세야 어느 설정에서도 「커밋하지 않은 변경 N개」가 참이다.

---

## 2. 두 이력은 층이 다르다 — 그래서 확장이 git 을 대신하면 안 된다

| | 무엇을 답하나 | 단위 | 소유 |
|---|---|---|---|
| **판**(잘커라 버전 N) | 지금 손님이 보는 것이 무엇이고 무엇으로 되돌릴 수 있나 — **배포 이력** | 발행 묶음(zip 전체) | 잘커라 |
| **커밋** | 소스가 어떻게 바뀌어 왔나 — **개발 이력** | 파일 변경 | 고객 |

「배포 이력은 git 에 애초 없다」(memo76)가 이 갈래의 뿌리다. 판 원장은 git 이 없어도 서고,
git 은 판 원장이 없어도 선다. 둘을 잇는 것은 **사람이 남기는 표식**(태그·커밋 메시지의 판 번호)
하나면 충분하고, 그것을 서버에 결속하는 순간 접은 memo84 로 돌아간다.

**폴더 = 작업 트리**라는 한 가지 사실이 둘을 실제로 잇는다. 「새 버전 배포」는 HEAD 가 아니라
**지금 디스크의 파일**을 올린다. 그래서 커밋하지 않은 변경이 있으면 「이 커밋이 라이브」는 거짓이다.
T2 가 그 자리에서 말하고, T3 은 그 자리가 깨끗할 때만 태그를 권한다.

---

## 3. 접점 셋 — 어디서 맞물리나

```
 git 이 디스크를 바꾼다  ─────▶  ① 확장이 알아차린다(T1)          ── 사이드바 「버전」이 참말
 확장이 디스크를 바꾼다  ─────▶  ② 문 앞에서 git 상태를 말한다(T2) ── 「교체」 전에 커밋 여부를 안다
 확장이 판을 만든다      ─────▶  ③ 사람이 표식을 남긴다(T3)        ── 「이 커밋 = 버전 N」
```

①은 확장이 **읽기만** 하고, ②는 **모달에 한 줄**을 더하고, ③만이 고객 git 에 **쓴다**. 셋의
순서가 곧 위험 순서라 T3 만 오너 결정에 건다.

---

## 4. 트랜치

### T0 — 문서(이 판)

- `doc/MANUAL.md` §5 「git · GitHub 와 함께 쓰기」 — 개발자·대행사용 작업 순서. **지금 동작으로만**
  적는다(T1~T3 을 약속하지 않는다).
- `packages/vscode/media/help.md` 「git 과 함께 쓰기」 — 사실 절(무엇을 남기고 무엇을 안 하나).
- 이 메모.

### T1 — 디스크 변화 감지 → 판 재계산

`vscode.workspace.createFileSystemWatcher(new RelativePattern(dir, "**/*"))` 의 생성·변경·삭제
셋을 **기존** `scheduleFolderVersion()` 으로 흘린다. 1.5초 묶음은 이미 있다.

🔴 **걸러야 도는 것이 있다.** 미리보기가 도는 동안 `.next/` 가 끊임없이 바뀐다. 안 거르면 묶음
타이머가 매번 되돌아가 **재계산이 영원히 안 돈다**(기아). 거르는 집합은 손 목록이 아니라 이미 있는
술어다 — `hashWorkdir` 가 안 세는 것(`node_modules`·`.next`·`dist`… `REGENERABLE` 과 포장 배제)과
`.git/` 안쪽, 그리고 `.zalkera/` 의 우리 기록물. 같은 술어를 안 쓰면 「세지도 않는 파일이 재계산을
막는」 형상이 된다.

대안(좁은 판): `vscode.git` 의 `repository.state.onDidChange` 만 듣는다. git 폴더에서만 듣고
git 확장이 이미 하는 감시에 얹히므로 비용이 0에 가깝다. 다만 **에이전트의 직접 쓰기**는 git 이
없는 폴더에서 못 잡는다 — 코드가 「디스크에 직접 쓰는 손」이라 이름 붙인 그 손이다. 정석은
감시기 하나로 두 손을 다 잡는 쪽이고, 감시기 비용이 실측으로 문제면 그때 좁힌다.

**검증**: 시험은 순수 함수(거름 술어)에 건다. 실물은 `git checkout` 뒤 1.5초 안에 사이드바가
「확인 중」→새 결론으로 가는지 눌러서 본다. 미리보기 켠 채 60초 두고 재계산이 **한 번은** 도는지
본다(기아 반증).

### T1' — `.zalkera/source.json` 을 `.git/info/exclude` 에

표식을 쓰는 자리(`writeMarkText`)에서, `.git/` 이 **디렉터리로** 있으면 `ignoreLedger` 와 같은
방식으로 `SOURCE_MARK_PATH` 를 `.git/info/exclude` 에 한 줄 넣는다. `.gitignore` 는 건드리지
않는다(§1 ⑤ 근거 그대로). 시작 소스 팩의 `.gitignore` 는 이미 이 경로를 빼고 있으나, 고객이
직접 만든 소스에는 그 줄이 없다.

**왜 표식을 커밋하면 안 되나** — 표식에는 기준점(`folderVersion`·`revisionNo`)이 들어 있다. 남의
기계에서 커밋된 기준점이 `git pull` 로 넘어오면 이 폴더는 「나는 판 7 에서 왔고 그 뒤로 안
고쳤다」는 남의 사실을 자기 것으로 믿는다 — 「수정 중」·「서버가 더 최신」이 거짓이 된다.
`.vscode/settings.json` 의 `zalkera.tenant` 는 기준점이 없는 **소속 한 줄**이라 반대다 — 전용
레포라면 커밋해 두면 clone 한 사람이 열자마자 사이트가 잡힌다(§6).

### T2 — 문 앞 git 한 줄

`say.serverReplaceConfirm`·zip 교체 확인·`say.publishConfirm` 의 `detail` 에 줄 하나를 더한다.
재료는 `vscode.git` API 에서 읽고(§1 ⑨), 확장 쪽에서 **문자열 하나**로 접어 core 의 `say` 에
넘긴다(core 는 VS Code 를 모른다).

```
git: main @ 1a2b3c4 · 커밋하지 않은 변경 3개
git: main @ 1a2b3c4 · 깨끗함
```

- git 확장이 없거나 꺼져 있거나 그 폴더가 레포가 아니면 **줄을 안 넣는다**. 「git 없음」이라 적지
  않는다 — 그건 판정이고, 판정하려면 `.git` 을 우리가 봐야 한다.
- 막지 않는다. 「zip 으로 내보내기 먼저」 단추가 이미 있으므로 단추를 늘리지 않는다.
- 발행 로그(출력 채널)에도 같은 줄을 남긴다 — `발행 → 버전 5 · git main @ 1a2b3c4 (미커밋 3)`.
  나중에 「어느 커밋이 5번인가」를 묻는 자리가 출력 채널이다.

**검증**: 세 갈래(없음·깨끗함·더러움) 문면 시험 + `untrackedChanges` 설정 두 값에서 합계가 같은지.
`check-wiring` 앵커(`listRevisions` → `pickRevision` 연접)를 건드리지 않는 자리에 끼운다 —
`detail` 조립은 판정 뒤다.

### T3 — 발행 뒤 태그 (오너 결정)

발행 성공 알림에 단추 하나 — **「git 태그 만들기」**. 누르면
`repository.tag("zalkera/v{N}", "잘커라 {site} 버전 {N}")`. 조건 둘을 **모두** 만족할 때만 단추가
뜬다: ⑴ 그 폴더가 레포다 ⑵ 발행 시점의 작업 트리가 깨끗했다(T2 의 재료). 더러운 트리에서 만든
태그는 라이브가 아닌 커밋을 가리키는 거짓이라 **권하지 않는다**(로그에만 남긴다).

- 태그는 **로컬**이다. 원격에 올리는 것은 VS Code 의 「태그 푸시」나 `git.followTagsWhenSync`
  이고 그것은 사람 손이다.
- 설정을 만들지 않는다. 단추는 누를 때만 쓴다 — 「매번 자동」은 제스처 없는 쓰기다.
- 「버전 전환」 목록에 `zalkera/v{N}` 태그가 있으면 `· git 태그 있음` 을 붙일 수 있다
  (`getRefs` 로 읽기). 이것은 T3 뒤의 작은 덤이고, 없어도 T3 은 완결이다.

**검증**: 태그 이름·메시지 순수 함수 시험. 실물은 더러운 트리에서 단추가 **안 뜨는지**(부정
단언의 양성 짝: 깨끗한 트리에서는 뜬다).

---

## 5. 왜 `.git/info/exclude` 인가 — 다시 적는다

`.gitignore` 는 **소스의 일부**다(판이 싣고 오고, 고객이 고친다). 우리 파일을 감추려고 거기 줄을
넣으면 ⑴ 다음 「서버 판으로 교체」가 그 줄을 지우고(서버 판의 `.gitignore` 로 돌아간다) ⑵ 되살리면
git 에 「`.gitignore` 수정됨」이 영구히 뜬다. `.git/info/exclude` 는 커밋되지 않고 판에도 안 실린다
(`.git` 이 배제 목록에 있다). 도구가 자기 파일을 감추는 표준 자리다. `.env.local` 만이 예외로
`.gitignore` 에 간다 — 그것은 **우리 파일이 아니라 고객의 비밀**이고, 그 줄은 `.gitignore` 에
있어야 다른 도구(`git add -A`·GitHub Desktop)도 지킨다.

---

## 6. 커밋해도 되는 것 / 안 되는 것 (매뉴얼 §6 의 근거)

| 경로 | 커밋 | 왜 |
|---|---|---|
| 소스 전부 · `.gitignore` · `.github/workflows/ci.yml` | O | 소스다 |
| `.vscode/settings.json`(`zalkera.tenant` 한 줄) | O — **전용 레포일 때** | 소속만 있고 기준점이 없다. 여러 사이트에 쓰는 템플릿 레포면 X |
| `.mcp.json` · `AGENTS.md` · `CLAUDE.md` | O | 열쇠가 없다(도움말이 그렇게 약속한다) |
| `.env.local` · `.env*` | **X** | 미리보기 열쇠. 확장이 `.gitignore` 에 보장한다(§1 ④) |
| `.zalkera/source.json` | **X** | 이 기계의 기준점(§T1') |
| `.zalkera/sync.json` | **X** | CLI 장부. CLI 가 스스로 감춘다(§1 ⑤) |
| `node_modules` · `.next` | X | 다시 만들어진다 |

---

## 7. DON'T-BUILD

- **GitHub API 호출 전부** — PAT 보관·PR 생성·이슈·Checks 읽기. VS Code 의 GitHub 확장이 한다.
  우리가 넣으면 「거래처 repo 를 관리하지 않는다」(memo84 접음의 불변식)가 확장 안에서 깨진다.
- **git 명령 실행** — 커밋·푸시·stash·checkout·`.gitignore` 자동 편집 확대. `.env.local` 한 줄만
  예외이고 그 예외의 근거는 §5 에 있다.
- **서버 측 레포 연결(LINKED) 재개** — 콘솔 입구가 닫힌 경로다. 이 메모는 그 반대편(고객 기계의
  git)만 다룬다.
- **git push 로 발행 트리거(GitHub Actions + CLI)** — CLI 에 헤드리스 자격이 없고(§1 ⑧), 만들면
  전 권한 장수 시크릿을 고객 레포 시크릿에 두는 축이다. 필요가 실측되면 **별도 메모**로 —
  자격증명의 범위(발행만·사이트 하나)와 수명이 먼저 정해져야 한다.
- **판 ↔ 커밋 결속을 서버에 저장** — memo84 `commit_sha`. 접은 이유가 그대로다.
- **3-way merge · 「내 변경만 남기고 갱신」** — `DECISIONS.md` 가 이미 적었다. git 이 한다.
- **확장 자체의 git 구현·번들** — `vscode.git` 이 있다. 없는 환경(git 미설치)에서는 접점이 없을 뿐
  확장은 그대로 돈다.
- **더티 트리 차단** — 「교체」·「발행」을 커밋 안 됐다고 막지 않는다. 말하고 사람이 정한다.

---

## 8. 오너 결정 대기

1. **T3 태그** — 확장이 고객 git 에 쓰는 첫 자리다. 단추(누를 때만) 형태로 여는가.
2. **`.vscode/settings.json` 커밋 권고**를 매뉴얼 §6 에 적는가 — 「전용 레포」 전제를 사람이
   판단해야 한다.
3. **교체 시 `.github/workflows/` 보존** — 지금은 문서로 알린다(§1 ⑥). 손 목록 없이 지키려면
   「서버가 저장하지 않는 접두는 서버 판이 지울 수 없다」는 규칙을 `keepNames` 에 얹어야 하는데
   `keepNames` 는 폴더 바로 아래 이름만 보고 `.github/` 전체는 서버가 저장하는 파일도 담는다
   (`CODEOWNERS` 같은). 부분 보존은 트리 걷기이고 그 실패면이 곧 「zip 으로 교체」가 막으려던
   사고다. 문서로 두고, 실제로 데이면 다시 연다.

---

## 9. 관련

- `DESIGN-server-replace.md` §9 DON'T-BUILD(더티 검출 기각) — T2 는 검출이 아니라 **인용**이다.
  판정하지 않고 git 이 말하는 것을 그대로 옮긴다.
- `DECISIONS.md` 「동시 업로드 — 덮어쓰기 방어」 — 3-way merge 는 git 수준.
- `packages/core/src/pull.ts` `ignoreLedger` — `.git/info/exclude` 의 근거.
