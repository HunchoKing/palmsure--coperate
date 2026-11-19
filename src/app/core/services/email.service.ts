import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class EmailService {
  // Vercel serverless function: api/send-email.js
  private apiUrl = '/api/send-email';

  constructor(private http: HttpClient) {}

  /** formData includes the hidden "website" honeypot field. */
  sendContactForm(formData: any): Observable<any> {
    return this.http.post(this.apiUrl, {
      type: 'contact',
      data: formData
    });
  }

  /** website is the hidden honeypot field; real visitors leave it empty. */
  sendQuoteRequest(insuranceType: string, personalDetails: any, specificDetails: any, website = ''): Observable<any> {
    return this.http.post(this.apiUrl, {
      type: 'quote',
      data: {
        type: insuranceType,
        personal: personalDetails,
        details: specificDetails,
        website
      }
    });
  }
}
