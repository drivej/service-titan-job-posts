<?php
/**
 * Client for the vendor-controlled entitlement and credential service.
 */

if (! defined('ABSPATH')) {
    exit;
}

class ST_Sync_Service_Client
{
    public function is_configured(): bool
    {
        return '' !== $this->base_url();
    }

    /**
     * @return array|WP_Error
     */
    public function checkout(string $email, string $plan)
    {
        $normalized_plan = in_array($plan, ['monthly', 'yearly'], true) ? $plan : 'monthly';
        $normalized_email = strtolower(sanitize_email($email));
        if ('' === $normalized_email || ! is_email($normalized_email)) {
            return new WP_Error('st_sync_invalid_checkout_email', 'Enter a valid billing email address.');
        }

        $response = $this->request('POST', '/v1/billing/checkout', [
            'email' => $normalized_email,
            'plan'  => $normalized_plan,
        ]);
        if (is_wp_error($response)) {
            return $response;
        }

        if (empty($response['checkout_url']) || empty($response['license_key'])) {
            return new WP_Error('st_sync_invalid_checkout', 'The hosted service returned an incomplete checkout response.');
        }

        return $response;
    }

    /**
     * @return array|WP_Error
     */
    public function activate(string $license_key)
    {
        $installation_id = (string) get_option('st_sync_installation_id', '');
        if ('' === $installation_id) {
            $installation_id = wp_generate_uuid4();
            update_option('st_sync_installation_id', $installation_id, false);
        }

        $response = $this->request('POST', '/v1/licenses/activate', [
            'license_key'    => trim($license_key),
            'site_url'       => home_url('/'),
            'installation_id'=> $installation_id,
            'delivery_url'   => rest_url('st-sync/v1/jobs'),
            'plugin_version' => ST_SYNC_VERSION,
            'policy'         => $this->local_policy(),
        ]);

        if (is_wp_error($response)) {
            return $response;
        }

        $required = ['site_id', 'activation_token', 'signing_secret', 'entitlement'];
        foreach ($required as $key) {
            if (empty($response[$key])) {
                return new WP_Error('st_sync_invalid_activation', 'The subscription service returned an incomplete activation.');
            }
        }

        update_option('st_sync_site', [
            'site_id'          => sanitize_text_field((string) $response['site_id']),
            'activation_token' => sanitize_text_field((string) $response['activation_token']),
            'signing_secret'   => sanitize_text_field((string) $response['signing_secret']),
            'entitlement'      => $this->sanitize_entitlement((array) $response['entitlement']),
            'checked_at'       => time(),
        ], false);

        return $response;
    }

    /**
     * @return array|WP_Error
     */
    public function status()
    {
        $response = $this->request('GET', '/v1/licenses/status', null, true);
        if (is_wp_error($response)) {
            return $response;
        }

        $site = $this->site();
        $site['entitlement'] = $this->sanitize_entitlement((array) ($response['entitlement'] ?? []));
        $site['connection'] = $this->sanitize_connection_status((array) ($response['connection'] ?? []));
        $site['sync'] = $this->sanitize_sync_status((array) ($response['sync'] ?? []));
        $site['checked_at'] = time();
        update_option('st_sync_site', $site, false);

        return $response;
    }

    /**
     * Send credentials directly to encrypted vendor storage. The client secret
     * is never written to a WordPress option.
     *
     * @return array|WP_Error
     */
    public function connect_servicetitan(array $connection)
    {
        $response = $this->request('PUT', '/v1/connections/servicetitan', [
            'tenant_id'    => preg_replace('/\D+/', '', (string) ($connection['tenant_id'] ?? '')),
            'client_id'    => $this->credential_text($connection['client_id'] ?? ''),
            'client_secret'=> $this->credential_text($connection['client_secret'] ?? ''),
            'environment'  => in_array(($connection['environment'] ?? ''), ['production', 'integration'], true)
                ? $connection['environment']
                : 'production',
        ], true);
        if (! is_wp_error($response)) {
            $site = $this->site();
            $site['connection'] = $this->sanitize_connection_status((array) $response);
            update_option('st_sync_site', $site, false);
        }

        return $response;
    }

    /**
     * @return array|WP_Error
     */
    public function update_policy(array $policy)
    {
        $allowed = [
            'min_price',
            'jobs_since',
            'min_summary_words',
            'completion_custom_field',
            'default_service_slug',
            'service_mappings',
            'allowed_cities',
            'excluded_job_types',
        ];
        return $this->request('PUT', '/v1/sites/policy', array_intersect_key($policy, array_flip($allowed)), true);
    }

    /**
     * @return array|WP_Error
     */
    public function billing_portal()
    {
        $response = $this->request('POST', '/v1/billing/portal', [], true);
        if (is_wp_error($response)) {
            return $response;
        }

        if (empty($response['portal_url'])) {
            return new WP_Error('st_sync_invalid_billing_portal', 'The hosted service did not return a billing portal URL.');
        }

        return $response;
    }

    /**
     * @return array|WP_Error
     */
    public function deactivate()
    {
        $response = $this->request('DELETE', '/v1/licenses/activation', null, true);
        if (! is_wp_error($response)) {
            delete_option('st_sync_site');
        }
        return $response;
    }

    public function site(): array
    {
        $site = get_option('st_sync_site', []);
        return is_array($site) ? $site : [];
    }

    public function is_connected(): bool
    {
        $site = $this->site();
        return ! empty($site['site_id']) && ! empty($site['activation_token']) && ! empty($site['signing_secret']);
    }

    /**
     * @return array|WP_Error
     */
    private function request(string $method, string $path, ?array $body = null, bool $authenticated = false)
    {
        $base_url = $this->base_url();
        if ('' === $base_url) {
            return new WP_Error(
                'st_sync_service_not_configured',
                'The hosted service URL is not configured in this plugin build.'
            );
        }

        $headers = ['Accept' => 'application/json'];
        if ($authenticated) {
            $token = (string) ($this->site()['activation_token'] ?? '');
            if ('' === $token) {
                return new WP_Error('st_sync_not_activated', 'Activate this site before calling the hosted service.');
            }
            $headers['Authorization'] = 'Bearer ' . $token;
        }

        $args = [
            'method'      => $method,
            'timeout'     => 20,
            'redirection' => 0,
            'sslverify'   => true,
            'headers'     => $headers,
        ];
        if (null !== $body) {
            $args['headers']['Content-Type'] = 'application/json';
            $args['body'] = wp_json_encode($body);
        }

        $response = wp_remote_request($base_url . $path, $args);
        if (is_wp_error($response)) {
            return $response;
        }

        $status = (int) wp_remote_retrieve_response_code($response);
        $decoded = json_decode((string) wp_remote_retrieve_body($response), true);
        if ($status < 200 || $status >= 300) {
            $message = is_array($decoded) && ! empty($decoded['error'])
                ? (string) $decoded['error']
                : sprintf('The hosted service returned HTTP %d.', $status);
            return new WP_Error('st_sync_service_error', sanitize_text_field($message), ['status' => $status]);
        }

        return is_array($decoded) ? $decoded : [];
    }

    private function base_url(): string
    {
        $configured = defined('ST_SYNC_SERVICE_URL')
            ? (string) ST_SYNC_SERVICE_URL
            : (defined('ST_SYNC_DEFAULT_SERVICE_URL') ? (string) ST_SYNC_DEFAULT_SERVICE_URL : '');
        $url = untrailingslashit((string) apply_filters('st_sync_service_url', $configured));
        if ('' === $url) {
            return '';
        }

        $scheme = (string) wp_parse_url($url, PHP_URL_SCHEME);
        $host = (string) wp_parse_url($url, PHP_URL_HOST);
        $is_local = in_array($host, ['localhost', '127.0.0.1', '::1'], true);
        if ('https' !== $scheme && ! ($is_local && in_array(wp_get_environment_type(), ['local', 'development'], true))) {
            return '';
        }

        return esc_url_raw($url);
    }

    private function sanitize_entitlement(array $entitlement): array
    {
        return [
            'eligible'           => ! empty($entitlement['eligible']),
            'status'             => sanitize_key((string) ($entitlement['status'] ?? 'unknown')),
            'plan'               => sanitize_key((string) ($entitlement['plan'] ?? '')),
            'current_period_end' => sanitize_text_field((string) ($entitlement['current_period_end'] ?? '')),
        ];
    }

    private function sanitize_connection_status(array $connection): array
    {
        return [
            'connected'   => ! empty($connection['connected']),
            'tenant_id'   => preg_replace('/\D+/', '', (string) ($connection['tenant_id'] ?? '')),
            'environment' => in_array(($connection['environment'] ?? ''), ['production', 'integration'], true)
                ? (string) $connection['environment']
                : '',
            'updated_at'  => sanitize_text_field((string) ($connection['updated_at'] ?? '')),
        ];
    }

    private function sanitize_sync_status(array $sync): array
    {
        return [
            'last_successful_sync_at' => sanitize_text_field((string) ($sync['last_successful_sync_at'] ?? '')),
            'last_sync_attempt_at'    => sanitize_text_field((string) ($sync['last_sync_attempt_at'] ?? '')),
            'last_sync_status'        => sanitize_key((string) ($sync['last_sync_status'] ?? '')),
            'last_sync_error'         => sanitize_textarea_field((string) ($sync['last_sync_error'] ?? '')),
            'last_sync_stats'         => $this->sanitize_sync_stats((array) ($sync['last_sync_stats'] ?? [])),
        ];
    }

    private function sanitize_sync_stats(array $stats): array
    {
        $clean = [];
        foreach ($stats as $key => $value) {
            $safe_key = sanitize_key((string) $key);
            if ('' === $safe_key) {
                continue;
            }

            if (is_array($value)) {
                $clean[$safe_key] = $this->sanitize_sync_stats($value);
            } elseif (is_bool($value)) {
                $clean[$safe_key] = $value;
            } elseif (is_numeric($value)) {
                $clean[$safe_key] = 0 + $value;
            } else {
                $clean[$safe_key] = sanitize_text_field((string) $value);
            }
        }

        return $clean;
    }

    private function local_policy(): array
    {
        $defaults = [
            'min_price'               => '0',
            'jobs_since'              => gmdate('Y-m-d', strtotime('-7 days')),
            'min_summary_words'       => '5',
            'completion_custom_field' => '',
            'default_service_slug'    => '',
            'service_mappings'        => '',
            'allowed_cities'          => '',
            'excluded_job_types'      => '',
        ];
        $options = get_option('st_sync_options', []);
        return array_intersect_key(wp_parse_args(is_array($options) ? $options : [], $defaults), $defaults);
    }

    private function credential_text($value): string
    {
        $text = trim((string) $value);
        return (string) preg_replace('/[\x00-\x1F\x7F]/', '', $text);
    }
}
