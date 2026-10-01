import type {
  AdminListSupportTicketsParams,
  BusinessContact,
  BusinessContactInput,
  ContactTicketInput,
  ContactTicketReceipt,
  Notification,
  NotificationList,
  PlatformOperationalStatus,
  SupportMessage,
  SupportMessageInput,
  SupportTicket,
  SupportTicketDetail,
  SupportTicketInput,
  SupportTicketInputCategory,
  SupportTicketStatus,
  SupportTicketStatusInput,
} from '@workspace/api-client-react';
import {
  adminGetSupportTicket,
  adminListSupportTickets,
  adminReplySupportTicket,
  adminUpdateSupportTicket,
  createContactTicket,
  createSupportTicket,
  getBusinessContact,
  getPlatformStatus,
  getSupportTicket,
  listNotifications,
  listSupportTickets,
  markAllNotificationsRead,
  markNotificationRead,
  replySupportTicket,
  updateBusinessContact,
} from '@workspace/api-client-react';

export type {
  AdminListSupportTicketsParams,
  BusinessContact,
  BusinessContactInput,
  ContactTicketInput,
  ContactTicketReceipt,
  Notification,
  NotificationList,
  PlatformOperationalStatus,
  SupportMessage,
  SupportMessageInput,
  SupportTicket,
  SupportTicketDetail,
  SupportTicketInput,
  SupportTicketInputCategory,
  SupportTicketStatus,
  SupportTicketStatusInput,
};
export type UserNotification = Notification;
export type TicketDetail = SupportTicketDetail;
export type TicketStatus = SupportTicketStatus;
export type TicketCategory = SupportTicketInputCategory;

export const publicContactTicket = createContactTicket;
export const ownSupportTickets = listSupportTickets;
export const createOwnSupportTicket = createSupportTicket;
export const ownSupportTicket = getSupportTicket;
export const replyToOwnSupportTicket = replySupportTicket;
export const adminSupportTickets = adminListSupportTickets;
export const adminSupportTicket = adminGetSupportTicket;
export const updateAdminSupportTicket = adminUpdateSupportTicket;
export const replyAsAdmin = adminReplySupportTicket;
export const userNotifications = listNotifications;
export const markUserNotificationRead = markNotificationRead;
export const markAllUserNotificationsRead = markAllNotificationsRead;
export const businessContactProfile = getBusinessContact;
export const saveBusinessContactProfile = updateBusinessContact;
export const platformOperationalStatus = getPlatformStatus;

export function formatSupportDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function deliveryNotice(): string {
  return 'In-app delivery is active. Email confirmations and replies are recorded for delivery, but email sending is not configured.';
}