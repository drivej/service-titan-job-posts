<?php
/**
 * Signed REST delivery endpoint used by the hosted sync service.
 */

if (! defined('ABSPATH')) {
    exit;
}

class ST_Sync_Sevalla_API
{
    public function __construct()
    {
        add_action('rest_api_init', [$this, 'register_routes']);
    }

    public function register_routes(): void
    {
        register_rest_route('st-sync/v1', '/jobs', [
            'methods'             => WP_REST_Server::CREATABLE,
            'callback'            => [$this, 'upsert_job'],
            'permission_callback' => [$this, 'verify_delivery_signature'],
        ]);
    }

    /**
     * Serialize each tenant/job upsert so concurrent deliveries cannot create
     * duplicate posts between lookup and insert.
     *
     * @return WP_REST_Response|WP_Error
     */
    public function upsert_job(WP_REST_Request $request)
    {
        $payload = $request->get_json_params();
        if (
            ! is_array($payload) ||
            empty($payload['source_tenant_id']) ||
            empty($payload['job_id'])
        ) {
            return $this->upsert_job_locked($request);
        }

        $lock_name = 'st_sync_' . substr(hash(
            'sha256',
            (string) $payload['source_tenant_id'] . ':' . (string) $payload['job_id']
        ), 0, 48);

        if (! $this->acquire_lock($lock_name)) {
            return new WP_Error(
                'st_sync_job_locked',
                'This job is already being delivered. Retry shortly.',
                ['status' => 409]
            );
        }

        try {
            return $this->upsert_job_locked($request);
        } finally {
            $this->release_lock($lock_name);
        }
    }

    /**
     * Create a pending job or update its existing post without bypassing review.
     *
     * Existing approved jobs retain their editorial copy and publication state.
     * New jobs always enter the pending review queue.
     *
     * @return WP_REST_Response|WP_Error
     */
    private function upsert_job_locked(WP_REST_Request $request)
    {
        $payload = $request->get_json_params();

        if (! is_array($payload)) {
            return new WP_Error('st_sync_invalid_payload', 'A JSON object is required.', ['status' => 400]);
        }

        $required = [
            'source_tenant_id',
            'job_id',
            'job_number',
            'completed_on',
            'city',
            'service_slug',
            'summary',
            'sync_hash',
        ];
        foreach ($required as $field) {
            if (! isset($payload[$field]) || '' === trim((string) $payload[$field])) {
                return new WP_Error(
                    'st_sync_missing_field',
                    sprintf('The %s field is required.', $field),
                    ['status' => 400]
                );
            }
        }

        $tenant_id = sanitize_text_field((string) $payload['source_tenant_id']);
        $job_id = sanitize_text_field((string) $payload['job_id']);
        $job_number = sanitize_text_field((string) $payload['job_number']);
        $city = sanitize_text_field((string) $payload['city']);
        $state = sanitize_text_field((string) ($payload['state'] ?? ''));
        $service_slug = sanitize_title((string) $payload['service_slug']);
        $service_name = sanitize_text_field((string) ($payload['service_name'] ?? $service_slug));
        $job_type_name = sanitize_text_field((string) ($payload['job_type_name'] ?? $service_name));
        $location_slug = sanitize_title((string) ($payload['location_slug'] ?? $city));
        $summary = sanitize_textarea_field((string) $payload['summary']);
        $completed_on = sanitize_text_field((string) $payload['completed_on']);
        $incoming_hash = sanitize_text_field((string) $payload['sync_hash']);

        if ('' === $service_slug || '' === $location_slug || '' === $summary) {
            return new WP_Error('st_sync_invalid_content', 'Service, location, and summary must be valid.', ['status' => 400]);
        }
        if (! preg_match('/^[a-f0-9]{64}$/i', $incoming_hash)) {
            return new WP_Error('st_sync_invalid_hash', 'The sync_hash field must be a SHA-256 hex digest.', ['status' => 400]);
        }
        if (false === strtotime($completed_on)) {
            return new WP_Error('st_sync_invalid_date', 'The completed_on field must be a valid date.', ['status' => 400]);
        }
        if (isset($payload['total']) && ! is_numeric($payload['total'])) {
            return new WP_Error('st_sync_invalid_total', 'The total field must be numeric when present.', ['status' => 400]);
        }

        $delivery_id = sanitize_text_field((string) $request->get_header('x-st-delivery-id'));
        $delivery_key = 'st_sync_delivery_' . hash('sha256', $delivery_id);
        if ($delivery_id && get_transient($delivery_key)) {
            return new WP_REST_Response([
                'created'   => false,
                'changed'   => false,
                'duplicate' => true,
            ], 200);
        }

        $existing_id = $this->find_job_by_source_id($tenant_id, $job_id);
        $existing_status = $existing_id ? get_post_status($existing_id) : false;
        $post_status = $existing_status ?: 'pending';
        $stored_hash = $existing_id ? (string) get_post_meta($existing_id, 'st_job_sync_hash', true) : '';

        if ($existing_id && $incoming_hash && hash_equals($stored_hash, $incoming_hash)) {
            if ($delivery_id) {
                set_transient($delivery_key, 1, 30 * DAY_IN_SECONDS);
            }

            return new WP_REST_Response([
                'id'        => $existing_id,
                'created'   => false,
                'changed'   => false,
                'status'    => $existing_status,
                'link'      => get_permalink($existing_id),
            ], 200);
        }

        if ($existing_id) {
            // Existing review/editorial state is immutable to automation. Record
            // that ServiceTitan changed, but never move the post, rewrite its
            // copy, or replace pending edits.
            update_post_meta($existing_id, 'st_job_tenant_id', $tenant_id);
            update_post_meta($existing_id, 'st_job_sync_hash', $incoming_hash);
            update_post_meta($existing_id, 'st_job_update_available', '1');
            update_post_meta($existing_id, 'st_job_pending_summary', $summary);
            update_post_meta($existing_id, 'st_job_pending_completed_on', $completed_on);
            update_post_meta($existing_id, 'st_job_pending_city', $city);
            update_post_meta($existing_id, 'st_job_pending_state', $state);
            update_post_meta($existing_id, 'st_job_pending_service_slug', $service_slug);
            update_post_meta($existing_id, 'st_job_pending_service_name', $service_name);
            update_post_meta($existing_id, 'st_job_pending_location_slug', $location_slug);
            update_post_meta($existing_id, 'st_job_pending_location_id', sanitize_text_field((string) ($payload['location_id'] ?? '')));
            update_post_meta($existing_id, 'st_job_pending_job_type_id', sanitize_text_field((string) ($payload['job_type_id'] ?? '')));
            update_post_meta($existing_id, 'st_job_pending_job_type_name', $job_type_name);
            update_post_meta($existing_id, 'st_job_pending_total', isset($payload['total']) ? (string) (float) $payload['total'] : '');
            if ($delivery_id) {
                set_transient($delivery_key, 1, 30 * DAY_IN_SECONDS);
            }

            return new WP_REST_Response([
                'id'             => $existing_id,
                'created'        => false,
                'changed'        => false,
                'source_changed' => true,
                'status'         => $existing_status,
                'link'           => get_permalink($existing_id),
            ], 200);
        }

        // Resolve taxonomy before creating the post so a transient term failure
        // cannot leave a hash-marked partial record.
        $service_term = $this->ensure_term($service_name, $service_slug, 'st_service');
        if (is_wp_error($service_term)) {
            return $service_term;
        }

        $location_term = $this->ensure_term($city, $location_slug, 'st_location');
        if (is_wp_error($location_term)) {
            return $location_term;
        }

        $post_data = [
            'post_type'    => 'st_job',
            'post_status'  => $post_status,
            'post_title'   => sprintf(
                '%s in %s',
                $job_type_name,
                $city
            ),
            'post_name'    => sanitize_title($job_number),
            'post_content' => wpautop(esc_html($summary)),
            'post_excerpt' => $summary,
            'meta_input'   => [
                'st_job_tenant_id'   => $tenant_id,
                'st_job_id'          => $job_id,
                'st_job_number'      => $job_number,
                'st_job_price'       => (float) ($payload['total'] ?? 0),
                'st_job_date'        => $completed_on,
                'st_job_city'        => $city,
                'st_job_state'       => $state,
                'st_job_service'     => $service_name,
                'st_job_summary'     => $summary,
                'st_job_location_id' => sanitize_text_field((string) ($payload['location_id'] ?? '')),
                'st_job_type_id'     => sanitize_text_field((string) ($payload['job_type_id'] ?? '')),
                'st_job_type_name'   => $job_type_name,
                'st_job_update_available' => '0',
            ],
        ];

        $post_id = wp_insert_post($post_data, true);
        if (is_wp_error($post_id)) {
            return $post_id;
        }

        $service_result = wp_set_object_terms($post_id, [(int) $service_term], 'st_service', false);
        $location_result = wp_set_object_terms($post_id, [(int) $location_term], 'st_location', false);
        if (is_wp_error($service_result) || is_wp_error($location_result)) {
            wp_delete_post($post_id, true);
            return is_wp_error($service_result) ? $service_result : $location_result;
        }

        update_post_meta($post_id, 'st_job_sync_hash', $incoming_hash);

        if ($delivery_id) {
            set_transient($delivery_key, 1, 30 * DAY_IN_SECONDS);
        }

        return new WP_REST_Response([
            'id'      => $post_id,
            'created' => true,
            'changed' => true,
            'status'  => get_post_status($post_id),
            'link'    => get_permalink($post_id),
        ], 201);
    }

    /**
     * Verify a five-minute HMAC envelope issued by the hosted service.
     *
     * Subscription status is intentionally not trusted here. The hosted service
     * owns billing truth and stops scheduling/delivery when entitlement ends.
     *
     * @return true|WP_Error
     */
    public function verify_delivery_signature(WP_REST_Request $request)
    {
        $site = get_option('st_sync_site', []);
        $site_id = is_array($site) ? (string) ($site['site_id'] ?? '') : '';
        $secret = is_array($site) ? (string) ($site['signing_secret'] ?? '') : '';
        if ('' === $site_id || '' === $secret) {
            return new WP_Error('st_sync_not_connected', 'This site is not connected to the sync service.', ['status' => 503]);
        }

        $provided_site = (string) $request->get_header('x-st-site-id');
        $timestamp = (string) $request->get_header('x-st-timestamp');
        $delivery_id = (string) $request->get_header('x-st-delivery-id');
        $provided_signature = (string) $request->get_header('x-st-signature');

        if (
            ! ctype_digit($timestamp) ||
            abs(time() - (int) $timestamp) > 300 ||
            '' === $delivery_id ||
            ! hash_equals($site_id, $provided_site)
        ) {
            return new WP_Error('st_sync_invalid_envelope', 'The delivery envelope is invalid or expired.', ['status' => 401]);
        }

        if (0 === strpos($provided_signature, 'v1=')) {
            $provided_signature = substr($provided_signature, 3);
        }

        $signed = $timestamp . '.' . $delivery_id . '.' . $request->get_body();
        $expected = hash_hmac('sha256', $signed, $secret);
        if (! hash_equals($expected, $provided_signature)) {
            return new WP_Error('st_sync_invalid_signature', 'The delivery signature is invalid.', ['status' => 401]);
        }

        return true;
    }

    private function find_job_by_source_id(string $tenant_id, string $job_id): int
    {
        $posts = get_posts([
            'post_type'              => 'st_job',
            'post_status'            => ['publish', 'pending', 'draft', 'private', 'future'],
            'posts_per_page'         => 1,
            'fields'                 => 'ids',
            'meta_query'             => [
                'relation' => 'AND',
                [
                    'key'   => 'st_job_tenant_id',
                    'value' => $tenant_id,
                ],
                [
                    'key'   => 'st_job_id',
                    'value' => $job_id,
                ],
            ],
            'no_found_rows'          => true,
            'update_post_meta_cache' => false,
            'update_post_term_cache' => false,
        ]);

        if (! empty($posts)) {
            return (int) $posts[0];
        }

        // Migrate posts created before tenant-scoped source keys were introduced.
        $legacy = get_posts([
            'post_type'      => 'st_job',
            'post_status'    => ['publish', 'pending', 'draft', 'private', 'future'],
            'posts_per_page' => 1,
            'fields'         => 'ids',
            'meta_query'     => [
                'relation' => 'AND',
                [
                    'key'   => 'st_job_id',
                    'value' => $job_id,
                ],
                [
                    'key'     => 'st_job_tenant_id',
                    'compare' => 'NOT EXISTS',
                ],
            ],
            'no_found_rows' => true,
        ]);

        return empty($legacy) ? 0 : (int) $legacy[0];
    }

    private function acquire_lock(string $lock_name): bool
    {
        global $wpdb;
        $result = $wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s, 5)', $lock_name));
        return '1' === (string) $result;
    }

    private function release_lock(string $lock_name): void
    {
        global $wpdb;
        $wpdb->get_var($wpdb->prepare('SELECT RELEASE_LOCK(%s)', $lock_name));
    }

    /**
     * @return int|WP_Error
     */
    private function ensure_term(string $name, string $slug, string $taxonomy)
    {
        $existing = term_exists($slug, $taxonomy);

        if (is_array($existing)) {
            return (int) $existing['term_id'];
        }

        if (is_int($existing)) {
            return $existing;
        }

        $created = wp_insert_term($name, $taxonomy, ['slug' => $slug]);
        if (is_wp_error($created)) {
            return $created;
        }

        return (int) $created['term_id'];
    }
}
