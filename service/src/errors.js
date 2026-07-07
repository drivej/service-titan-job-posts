'use strict';

class ServiceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    this.code = code;
  }
}

function serviceError(status, code, message) {
  return new ServiceError(status, code, message);
}

module.exports = {
  ServiceError,
  serviceError
};
