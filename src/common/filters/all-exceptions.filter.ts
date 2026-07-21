import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { ERROR_CODES } from '../constants/error-code';

/**
 * REST 응답 봉투를 통일하는 전역 예외 필터.
 * 성공은 컨트롤러가 { success: true, data } 로 내보내므로, 에러도 형태를 맞춘다:
 *   { success: false, error: { code, message } }
 *
 * - 서비스가 던지는 HttpException 의 body 에 code 가 있으면(예: { code, message }) 그걸 쓴다.
 * - ValidationPipe 의 BadRequest 는 code 가 없으므로 VALIDATION_ERROR 로 매핑한다.
 * - 그 외 알 수 없는 예외는 500 + 기본 코드로 감싼다(내부 스택은 노출하지 않는다).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    // 이 필터는 REST 전용. WS 에러는 게이트웨이가 {code} ack 로 이미 처리하므로,
    // HTTP 가 아닌 컨텍스트(웹소켓 등)에서는 HTTP 응답을 건드리지 않는다(안 그러면 크래시).
    if (host.getType() !== 'http') {
      this.logger.error(exception);
      return;
    }

    const res = host.switchToHttp().getResponse<Response>();

    const { status, code, message } = this.resolve(exception);

    if (status >= 500) {
      // 5xx 는 서버 문제라 원인을 로깅해 둔다(응답 본문엔 노출하지 않음).
      this.logger.error(exception);
    }

    res.status(status).json({ success: false, error: { code, message } });
  }

  private resolve(exception: unknown): {
    status: number;
    code: string;
    message: string;
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();

      // 서비스가 { code, message } 형태로 던진 경우 그대로 사용.
      if (typeof body === 'object' && body !== null && 'code' in body) {
        const b = body as { code?: unknown; message?: unknown };
        return {
          status,
          code:
            typeof b.code === 'string' ? b.code : this.codeFromStatus(status),
          message:
            typeof b.message === 'string' ? b.message : exception.message,
        };
      }

      // ValidationPipe 등 표준 예외: message 는 문자열 또는 문자열 배열.
      const message =
        typeof body === 'object' && body !== null && 'message' in body
          ? this.flattenMessage(body.message)
          : exception.message;

      return { status, code: this.codeFromStatus(status), message };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: '서버 오류가 발생했습니다.',
    };
  }

  /** 검증 오류 message 는 배열로 오므로 하나의 문자열로 합친다. */
  private flattenMessage(message: unknown): string {
    if (Array.isArray(message)) return message.join(', ');
    return typeof message === 'string' ? message : '요청이 올바르지 않습니다.';
  }

  /** code 가 없는 표준 예외의 status → 우리 에러 코드 매핑. */
  private codeFromStatus(status: number): string {
    switch (status) {
      case 400: // BAD_REQUEST (ValidationPipe 등)
        return ERROR_CODES.VALIDATION_ERROR;
      case 404: // NOT_FOUND
        return ERROR_CODES.ROOM_NOT_FOUND;
      default:
        return 'INTERNAL_ERROR';
    }
  }
}
