# @zalkera/devtools-cli

터미널에서 쓰는 길. VS Code 를 쓰지 않거나, 스크립트·CI 에서 돌릴 때를 위한 것이다.

> **상태: 착수 전.** `src` 가 비어 있고 npm 에 올라가 있지 않다. 아래 명령은 **예정된 표면**이지 지금
> 동작하는 것이 아니다.

## 예정 사용법

```
npx zalkera login              # 브라우저로 로그인
npx zalkera site pull          # 지금 배포 중인 내 사이트 소스를 로컬로
npx zalkera preview            # 개발 서버 기동 → 실제 브라우저로 열기
npx zalkera publish            # 묶어서 올리기
npx zalkera rollback           # 이전 리비전으로
npx zalkera doctor             # 무엇이 없어서 안 되는지 점검
```

요구사항: **Node.js 20+**. (확장으로 쓰면 Node 설치가 필요 없다 — VS Code 가 이미 싣고 있는 것을 쓴다.)

로직은 전부 [`@zalkera/devtools-core`](../core) 에 있다. 이 패키지는 인자 해석과 출력만 맡는다.

## 라이선스

MIT © Credium
