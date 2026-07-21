/**
 * e2e 전용 셋업.
 *
 * 각 스위트의 afterAll 에서 app.close() 가 Redis 연결을 quit 하는 순간,
 * 아직 처리 중이던 소켓 disconnect 핸들러의 Redis 명령이 "Connection is closed" 로
 * reject 될 수 있다. 기능과 무관한 종료 시점 잡음이므로, 이 메시지에 한해서만 무시하고
 * 나머지 unhandledRejection 은 그대로 드러낸다(실제 버그를 가리지 않기 위해).
 */
process.on('unhandledRejection', (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (message.includes('Connection is closed')) return;
  throw reason;
});
