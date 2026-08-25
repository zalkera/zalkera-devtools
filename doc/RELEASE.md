# `zalkera-devtools` 발행 절차

> **이 문서가 생긴 이유.** 레포 루트에서 `npx vsce publish` 를 부르면 이렇게 죽는다:
>
> ```
> ERROR  Missing vscode engine compatibility version.
>        ("engines": { "vscode": "<version>" } in package.json)
> ```
>
> 확장은 **npm 워크스페이스 멤버**(`packages/vscode`)라 `vsce` 가 **레포 루트를 패키지 루트로**
> 잡는다. 루트 `package.json` 은 모노레포 루트라 `engines` 가 없다. `scripts/package-vsix.mjs`
> 가 그 함정을 피하려고 워크스페이스가 없는 스테이징에서 포장하는데, 그 사실이 어디에도 안
> 적혀 있어 발행하는 사람이 매번 같은 자리에서 막혔다.

---

## 0. 언제 버전을 올리나

`packages/vscode/package.json` 의 `version` 이 마켓의 그것과 같으면 **마켓이 재발행을 거절한다.**
소스를 고쳤으면 반드시 올린다.

**등급**:

- **patch** — 고객이 보는 동작이 그대로이거나 결함만 사라지는 변경(성능·거짓 경고 제거·문면).
- **minor** — 고객이 보던 것이 달라지는 변경. 명령·설정·알림 문면이 바뀌거나, **검사기가 새로
  경고를 내는** 경우가 여기다. 진단은 편집기에 바로 뜨므로 「지금까지 안 뜨던 것이 뜬다」는
  고객에게는 동작 변경이다.

⚠ **버전 드리프트를 잡는 검사기가 없다.** `npm run verify` 의 검사기 어느 것도 `version` 을
마켓과 대조하지 않는다. 그래서 아래 §3 의 태그가 유일한 기록이다.

---

## 1. 굽기

```bash
cd zalkera-devtools
npm run package          # 버전은 이미 올려 둔 값으로. 올리면서 구우려면 package:patch / package:minor
```

`npm run verify`(시험 + 검사기 전량)를 먼저 돌리고, `dist/zalkera-devtools-<version>.vsix` 와
`shared/` 사본을 만든다. **`vsce` 는 이 스크립트 안에서만 부른다** — 직접 부르면 위 오류가 난다.

산출물이 이번 변경을 실제로 담았는지 확인한다:

```bash
unzip -p dist/zalkera-devtools-<version>.vsix extension/dist/extension.cjs | grep -c '<식별자>'
```

⚠ **비-ASCII 로 grep 하지 마라.** esbuild 는 문자열 리터럴의 한글을 `\uXXXX` **대문자 16진**으로
이스케이프한다(주석은 그대로 남는다). 한글로 찾으면 「수정이 번들에 없다」고 오보한다.
식별자·ASCII 패턴으로 찾을 것.

---

## 2. 발행 (오너)

```bash
npx vsce publish --packagePath dist/zalkera-devtools-<version>.vsix
```

**이미 구운 파일을 올린다.** `--packagePath` 없이 부르면 `vsce` 가 다시 포장하려 들면서 §0 의
오류가 난다.

발행은 마켓플레이스 자격증명이 필요하다 — **오너만 할 수 있다.** 에이전트는 여기서 멈추고
그 사실을 말한다.

---

## 3. 발행 **다음** — 태그를 찍는다

`dist/*.vsix` 는 gitignore 다. 태그를 안 찍으면 **어느 트리가 나갔는지 아무 데도 안 남는다.**
실제로 한 번 그랬다 — 같은 버전 번호로 커밋 열 개가 쌓여, 마켓의 그 버전이 무엇인지 레포
안에서 판별할 수 없었다.

```bash
BUNDLE=$(unzip -p dist/zalkera-devtools-<version>.vsix extension/dist/extension.cjs | sha256sum | cut -d' ' -f1)
VSIX=$(sha256sum dist/zalkera-devtools-<version>.vsix | cut -d' ' -f1)
git tag -a v<version> -m "발행본 sha256: vsix $VSIX · bundle $BUNDLE
재현(번들): npm run package && unzip -p dist/zalkera-devtools-<version>.vsix extension/dist/extension.cjs | sha256sum" HEAD
git push origin v<version>
```

두 sha 의 쓰임이 다르다.

- **번들 sha** 는 **재현된다**. esbuild 산출물이 결정론적이라 같은 트리에서 다시 구우면 같다.
  나중에 「마켓의 그 판이 어느 트리냐」를 되짚는 것은 이쪽이다.
- **vsix sha** 는 **재현되지 않는다.** 스테이징에서 `node_modules` 를 복사할 때 zip 항목 **순서**가
  실행마다 달라진다(내용은 같다). 이 값은 마켓이 알려 주는 `VsixSha256` 과 대조하는
  **발행본 식별자**로만 쓴다.

---

## 4. 갱신 안내는 **비파괴 한 줄**로만 적는다

배송 문서(README·help)가 사용자에게 시키는 갱신 명령은 이것 하나다.

```bash
code --install-extension zalkera.zalkera-devtools --force
```

**지우라고 하지 마라.** `uninstall` 과 `install` 을 한 펜스에 담으면, 통째로 복붙한 사람이
2줄에서 네트워크·마켓 장애를 만났을 때 **확장이 사라진 채로 남는다.** 그 사람에게는 `.vsix`
파일도 없다.

⚠ **「파일로 깔면 갱신을 못 받는다」를 단정하지 마라.** VS Code 1.134.0 번들을 읽어 확인한
것은 둘이다 — VSIX 설치가 끝나면 `this.source instanceof …&&this.updateMetadata(...)` 가 돌고,
갱신 대상 선별은 `a.identifier.uuid&&n.push(...)` 로 uuid 만 본다. 즉 마켓에 올라간 뒤에 파일로
깐 사람은 갱신 대상에 들어간다. 종전 문면은 그들에게 필요 없는 수술을 시켰다.

**이 박스에서는 실동작을 재현하지 못했다** — 여기 VS Code Server 에는 확장이 하나도 안 깔려
있다. 데스크톱에서 확인하기 전에는 어느 방향으로도 단정하지 말 것.

포크(Cursor·Windsurf)는 다르다. OpenVSX 에 `zalkera` 네임스페이스가 없어(실측 404) 마켓 경로로는
설치가 안 되고, 자동 갱신도 오지 않는다. 그 사실은 배송 문서에 적혀 있어야 한다.

강제로 올려야 하면 `minExtensionVersion`(백엔드 설정)을 올리는 길이 있다. 그러면 그 미만 판은
알림이 아니라 **하던 일이 멈춘다** — 사용자 작업을 끊는 것이라 오너 판단이다.

## 5. 변경 기록에 무엇을 적나

`packages/vscode/CHANGELOG.md` 는 **고객이 마켓에서 읽는 문서**다. 우리 규율을 설명하는 자리가
아니다 — 방침 문장은 여기 적고, 거기에는 결과만 적는다.

- 보안 수정은 **무엇이 고쳐졌는지까지만.** 재현 조건·크기·형상은 적지 않는다 — 아직 옛 판을
  쓰는 사람이 그대로 노출된다.
- 그렇다고 **빼지도 않는다.** 「올려야 할 이유」가 안 보이면 그 사람은 옛 판에 남는다.
  「…를 고쳤습니다. 그 밖에 안전 관점의 수정이 여럿 있습니다」 정도가 두 요구를 다 만족한다.

## 6. 체크리스트

```
[ ] packages/vscode/package.json 의 version 을 올렸다
[ ] packages/vscode/CHANGELOG.md 에 이번 판 항목을 적었다 (VSIX 안에 실려 마켓에 그대로 뜬다)
[ ] npm run package  (verify 통과 + vsix 생성)
[ ] 번들에 이번 변경이 들어갔는지 ASCII 패턴으로 확인
[ ] npx vsce publish --packagePath dist/…vsix   (오너)
[ ] v<version> 태그를 sha256 과 함께 찍고 push
[ ] 파일로 깔아 둔 사람이 있으면 마켓 경로로 다시 깔라고 안내 (§4)
[ ] §7 표에 이 판의 심의 상태를 적었다 — 「미이수」면 그렇게 적는다
```

## 7. Fable 심의 이수 현황

**표준은 3단이다: Fable 설계 → Opus 검토·구현 → Fable 심의(3축: 기능·보안·성능).** Fable 한도가
차면 심의를 Opus 로 돌리는데, 그것은 **대체가 아니라 임시**다 — 설계자가 자기 설계대로 됐는지
본 적이 없는 판이 쌓이므로 어느 것이 미이수인지 여기 적는다. 안 적으면 나중에 몰아서 받을
목록을 만들 수 없다.

⚠ **미이수는 「결함이 있다」는 뜻이 아니다.** Opus 3축과 검사기·시험을 지난 판이다. 다만
「설계자가 본 적 없다」는 사실이 기록으로 남아야 한다.

| 판 | 커밋 | 받은 심의 | Fable |
|---|---|---|---|
| 0.11.0 | `94177cc` | 4회전(1회전 3축 → **2회전 설계자** → 3·4회전 조건 이행) | 이수 |
| **0.11.1** | `412ae54` | Opus 단독(4회전 심의가 문서 패스로 남긴 잔여 정리) | **필요** |
| **T5b(0.11.2 에 실림)** | `6eea8eb` | Opus 3축 — memo183 T5 행과 같은 트랜치 | **필요** |
| **0.11.2** | `2ba180e` | Opus 자기 검수(「앞 커밋 검수 — 모순 없음」) | **필요** |
| 0.11.3 · 0.12.0 | `63e5f39`·`bc12628`·`e027ee9` | 설계 심의(반려·대안) + 3축 | 기능 이수 · 보안·성능 진행 |

- T5b 는 백엔드 `doc/design/memos/183-nondev-source-edit.md` 의 미이수 표에도 같은 사유로 올라
  있다(그 표의 T5 행이 `devtools 6eea8eb` 를 든다). **두 곳이 같은 사실을 말해야 한다.**
- Fable 이 볼 것은 재심의가 아니라 ⑴ Opus 심의 반영이 설계 의도와 맞는가 ⑵ Opus 가 **자기
  구현을 자기가 심의해서** 못 본 것이다.
