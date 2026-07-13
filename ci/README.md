# CI 배포 워크플로

`ci/deploy.yml` 은 GitHub Actions 배포 워크플로 정의입니다.

현재 배포는 `gh-pages` 브랜치(정적 dist) + GitHub Pages 로 이루어집니다.
Actions 자동 빌드/스케줄 갱신을 켜려면:

1. gh 토큰에 `workflow` 스코프 부여: `gh auth refresh -h github.com -s workflow`
2. `ci/deploy.yml` 을 `.github/workflows/deploy.yml` 로 이동 후 커밋/푸시
3. Pages 소스를 GitHub Actions 로 전환

(최초 생성 시 OAuth 토큰에 workflow 스코프가 없어 .github/workflows 경로 푸시가 거부되어 이 위치에 보관합니다.)
