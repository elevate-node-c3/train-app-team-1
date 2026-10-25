import { Observable } from 'rxjs';

export interface ISignUpRequest {
  name: string;
  email: string;
  password: string;
}
export interface ILoginRequest {
  email: string;
  password: string;
}
export interface IConfirmEmailRequest {
  email: string;
  otp: string;
}
export interface IResendOTPRequest {
  email: string;
}
export interface IRefreshRequest {
  refreshToken: string;
}
export interface IForgetPasswordRequest {
  email: string;
}
export interface IConfirmOTPRequest {
  email: string;
  otp: string;
}

export interface IResetPassword {
  newPassword: string;
}
export interface ILogout {
  refreshToken: string;
}

export interface IIdentityGrpcServices {
  signUp(data: ISignUpRequest): Observable<any>;
  signIn(data: ILoginRequest): Observable<any>;
  confirmEmail(data: IConfirmEmailRequest): Observable<any>;
  resendOTP(data: IResendOTPRequest): Observable<any>;
  refresh(data: IRefreshRequest): Observable<any>;
  forgetPassword(data: IForgetPasswordRequest): Observable<any>;
  confirmOTP(data: IConfirmOTPRequest): Observable<any>;
  resetPassword(data: IResetPassword): Observable<any>;
  logout(data: ILogout): Observable<any>;
}
