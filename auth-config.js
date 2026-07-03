// ============================================================
//  WebCAD 로그인 설정
//  Supabase 프로젝트를 만든 뒤 아래 두 값을 채우면 로그인 게이트가 활성화됩니다.
//  (비어 있으면 로그인 없이 기존처럼 동작)
//
//  1) https://supabase.com → New project 생성
//  2) Project Settings → API 에서
//     - Project URL  → url 에 붙여넣기
//     - anon public key → anonKey 에 붙여넣기
//  3) SQL Editor 에서 supabase-setup.sql 내용 실행
//  4) Authentication → Email Templates → "Confirm signup" 본문을
//     인증번호 {{ .Token }} 이 보이도록 수정 (예: <h2>{{ .Token }}</h2>)
//     "Reset password" 템플릿도 동일하게 {{ .Token }} 포함
// ============================================================
window.WEBCAD_AUTH = {
  url: '',       // 예: 'https://abcdefgh.supabase.co'
  anonKey: '',   // 예: 'eyJhbGciOi...'
};
