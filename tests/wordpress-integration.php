<?php
/**
 * Destructive-but-cleaned integration test for a disposable WordPress site.
 *
 * Usage:
 * WP_ROOT=/path/to/wordpress php tests/wordpress-integration.php
 */

$wp_root = rtrim((string) getenv('WP_ROOT'), '/');
if ('' === $wp_root || ! file_exists($wp_root . '/wp-load.php')) {
    fwrite(STDERR, "Set WP_ROOT to a disposable WordPress installation.\n");
    exit(2);
}

if (! defined('ST_SYNC_SERVICE_URL')) {
    define('ST_SYNC_SERVICE_URL', 'https://subscription-service.example.test');
}

$st_wp_bootstrapped = false;
ob_start();
register_shutdown_function(static function () use (&$st_wp_bootstrapped): void {
    if ($st_wp_bootstrapped) {
        return;
    }

    $bootstrap_output = (string) ob_get_contents();
    if ('' === trim($bootstrap_output)) {
        return;
    }

    ob_end_clean();
    $message = (string) preg_replace('/<(style|script)\b[^>]*>.*?<\/\1>/is', '', $bootstrap_output);
    fwrite(STDERR, "WordPress bootstrap failed before integration tests could run:\n");
    fwrite(STDERR, trim(html_entity_decode(strip_tags($message))) . "\n");
    exit(2);
});
require $wp_root . '/wp-load.php';
$st_wp_bootstrapped = true;
$bootstrap_output = (string) ob_get_clean();
if ('' !== trim($bootstrap_output)) {
    echo $bootstrap_output;
}

if (! class_exists('ST_Sync_Sevalla_API')) {
    fwrite(STDERR, "ServiceTitan Local Job Content must be active.\n");
    exit(2);
}

do_action('init');

$admins = get_users(['role' => 'administrator', 'number' => 1, 'fields' => 'ID']);
if (empty($admins)) {
    fwrite(STDERR, "The test site needs an administrator account.\n");
    exit(2);
}
wp_set_current_user((int) $admins[0]);

$created_posts = [];
$created_terms = [];
$api = new ST_Sync_Sevalla_API();
$failure = null;
$run_token = 'integration-' . bin2hex(random_bytes(4));
$service_slug = 'plumbing-' . $run_token;
$location_slug = 'newark-' . $run_token;
$had_site_option = false !== get_option('st_sync_site', false);
$previous_site_option = get_option('st_sync_site', []);
$test_site = [
    'site_id'        => 'site-' . $run_token,
    'signing_secret' => bin2hex(random_bytes(32)),
];
update_option('st_sync_site', $test_site, false);
$had_sync_options = false !== get_option('st_sync_options', false);
$previous_sync_options = get_option('st_sync_options', []);

function st_test_assert($condition, string $message): void
{
    if (! $condition) {
        throw new RuntimeException($message);
    }
}

function st_test_request(array $payload, array $site): WP_REST_Request
{
    $body = wp_json_encode($payload);
    $timestamp = (string) time();
    $delivery_id = 'delivery-' . hash('sha256', $body);
    $signature = hash_hmac(
        'sha256',
        $timestamp . '.' . $delivery_id . '.' . $body,
        $site['signing_secret']
    );
    $request = new WP_REST_Request('POST', '/st-sync/v1/jobs');
    $request->set_header('content-type', 'application/json');
    $request->set_header('x-st-site-id', $site['site_id']);
    $request->set_header('x-st-timestamp', $timestamp);
    $request->set_header('x-st-delivery-id', $delivery_id);
    $request->set_header('x-st-signature', 'v1=' . $signature);
    $request->set_body($body);
    return $request;
}

function st_test_json_ld_scripts(string $html): array
{
    preg_match_all('#<script type="application/ld\+json">(.*?)</script>#s', $html, $matches);
    return array_values(array_filter(array_map(static function (string $json) {
        $decoded = json_decode($json, true);
        return is_array($decoded) ? $decoded : null;
    }, $matches[1] ?? [])));
}

try {
    $parent_id = wp_insert_post([
        'post_type'   => 'page',
        'post_status' => 'publish',
        'post_title'  => 'Plumbing Integration Test',
        'post_name'   => $service_slug,
    ], true);
    st_test_assert(! is_wp_error($parent_id), 'Could not create service page.');
    $created_posts[] = (int) $parent_id;

    $city_id = wp_insert_post([
        'post_type'   => 'page',
        'post_status' => 'publish',
        'post_parent' => (int) $parent_id,
        'post_title'  => 'Newark Integration Test',
        'post_name'   => $location_slug,
    ], true);
    st_test_assert(! is_wp_error($city_id), 'Could not create location page.');
    $created_posts[] = (int) $city_id;

    $unrelated_parent = wp_insert_post([
        'post_type'   => 'page',
        'post_status' => 'publish',
        'post_title'  => 'Unrelated Parent',
        'post_name'   => 'unrelated-' . $run_token,
    ], true);
    $created_posts[] = (int) $unrelated_parent;
    $unrelated_child = wp_insert_post([
        'post_type'   => 'page',
        'post_status' => 'publish',
        'post_parent' => (int) $unrelated_parent,
        'post_title'  => 'Unrelated Child',
        'post_name'   => 'child-' . $run_token,
    ], true);
    $created_posts[] = (int) $unrelated_child;
    $unrelated_grandchild = wp_insert_post([
        'post_type'   => 'page',
        'post_status' => 'publish',
        'post_parent' => (int) $unrelated_child,
        'post_title'  => 'Unrelated Grandchild',
        'post_name'   => 'grandchild-' . $run_token,
    ], true);
    $created_posts[] = (int) $unrelated_grandchild;
    st_test_assert(
        (int) $unrelated_grandchild === url_to_postid(get_permalink($unrelated_grandchild)),
        'The job rewrite intercepted an unrelated three-level page.'
    );

    for ($index = 1; $index <= 4; $index++) {
        $payload = [
            'source_tenant_id' => 'tenant-integration',
            'job_id'       => $run_token . '-' . $index,
            'job_number'   => 'INTEGRATION-' . $index,
            'completed_on' => sprintf('2026-07-%02dT12:00:00Z', $index),
            'total'        => 500 + $index,
            'city'         => 'Newark Integration Test',
            'state'        => 'NJ',
            'location_slug'=> $location_slug,
            'location_id'  => 'location-' . $index,
            'job_type_id'  => 'type-1',
            'service_slug' => $service_slug,
            'service_name' => 'Plumbing Integration Test',
            'summary'      => sprintf('Integration job number %d cleared a blocked drain with professional equipment.', $index),
            'sync_hash'    => hash('sha256', $run_token . '-' . $index),
        ];
        $request = st_test_request($payload, $test_site);
        st_test_assert(true === $api->verify_delivery_signature($request), 'A valid delivery signature was rejected.');
        $response = $api->upsert_job($request);
        st_test_assert($response instanceof WP_REST_Response, 'Upsert did not return a REST response.');
        st_test_assert(201 === $response->get_status(), 'New job did not return HTTP 201.');
        $data = $response->get_data();
        $job_post_id = (int) $data['id'];
        $created_posts[] = $job_post_id;

        st_test_assert('pending' === get_post_status($job_post_id), 'New job was not pending review.');
        st_test_assert(
            has_block('st-sync/job-details', (string) get_post_field('post_content', $job_post_id)),
            'New job did not use the Job Details block by default.'
        );
        wp_update_post(['ID' => $job_post_id, 'post_status' => 'publish']);
        $job_permalink = get_permalink($job_post_id);
        st_test_assert(
            false !== strpos($job_permalink, '/' . $service_slug . '/' . $location_slug . '/job/'),
            'Published job permalink was not nested beneath service/location: ' . $job_permalink
        );
        st_test_assert(
            $job_post_id === url_to_postid($job_permalink),
            'The nested job permalink did not resolve back to its post.'
        );
    }

    $service_term = get_term_by('slug', $service_slug, 'st_service');
    $location_term = get_term_by('slug', $location_slug, 'st_location');
    if ($service_term) {
        $created_terms[] = ['id' => (int) $service_term->term_id, 'taxonomy' => 'st_service'];
    }
    if ($location_term) {
        $created_terms[] = ['id' => (int) $location_term->term_id, 'taxonomy' => 'st_location'];
    }

    $block = sprintf(
        '<!-- wp:st-sync/recent-jobs {"serviceSlug":"%s","locationSlug":"%s","jobsToShow":3} /-->',
        $service_slug,
        $location_slug
    );
    $rendered = do_blocks($block);
    st_test_assert(3 === substr_count($rendered, 'st-recent-jobs__card'), 'Location block did not render exactly three jobs.');
    st_test_assert(
        false !== strpos($rendered, 'st-recent-jobs__intro') &&
        false !== strpos($rendered, 'recent Plumbing Integration Test jobs completed in Newark Integration Test'),
        'Location block did not render generated local intro copy.'
    );
    st_test_assert(
        false === strpos($rendered, 'Integration job number 1'),
        'Location block did not select the three most recent jobs.'
    );
    st_test_assert(
        false !== strpos($rendered, 'Integration job number 4'),
        'Location block omitted the most recent job.'
    );
    $recent_schemas = st_test_json_ld_scripts($rendered);
    $item_list = $recent_schemas[0] ?? [];
    st_test_assert(
        'ItemList' === ($item_list['@type'] ?? '') &&
        false !== strpos((string) ($item_list['description'] ?? ''), 'Newark Integration Test') &&
        3 === count($item_list['itemListElement'] ?? []) &&
        'Service' === ($item_list['itemListElement'][0]['item']['@type'] ?? ''),
        'Recent jobs block did not emit Service ItemList JSON-LD.'
    );

    update_option('st_sync_options', array_merge(
        is_array($previous_sync_options) ? $previous_sync_options : [],
        ['recent_jobs_count' => '2']
    ));
    $global_count_block = sprintf(
        '<!-- wp:st-sync/recent-jobs {"serviceSlug":"%s","locationSlug":"%s"} /-->',
        $service_slug,
        $location_slug
    );
    st_test_assert(
        2 === substr_count(do_blocks($global_count_block), 'st-recent-jobs__card'),
        'An attribute-less block did not inherit the global recent-job count.'
    );
    $blocks_renderer = new ST_Sync_Blocks();
    $auto_rendered = $blocks_renderer->append_recent_jobs_for_page('<p>City page copy.</p>', (int) $city_id);
    st_test_assert(
        false !== strpos($auto_rendered, 'City page copy.') &&
        2 === substr_count($auto_rendered, 'st-recent-jobs__card'),
        'Matching location page did not auto-append recent jobs.'
    );
    update_option('st_sync_options', array_merge(
        is_array(get_option('st_sync_options', [])) ? get_option('st_sync_options', []) : [],
        ['auto_append_recent_jobs' => '0']
    ));
    st_test_assert(
        false === strpos($blocks_renderer->append_recent_jobs_for_page('<p>City page copy.</p>', (int) $city_id), 'st-recent-jobs__card'),
        'Auto-append recent jobs setting did not disable automatic location-page output.'
    );
    update_option('st_sync_options', array_merge(
        is_array(get_option('st_sync_options', [])) ? get_option('st_sync_options', []) : [],
        ['auto_append_recent_jobs' => '1']
    ));
    wp_update_post([
        'ID'           => (int) $city_id,
        'post_content' => $global_count_block,
    ]);
    $deduped_rendered = $blocks_renderer->append_recent_jobs_for_page(do_blocks($global_count_block), (int) $city_id);
    st_test_assert(
        2 === substr_count($deduped_rendered, 'st-recent-jobs__card'),
        'Auto-append duplicated a manually placed Recent Local Jobs block.'
    );
    wp_update_post([
        'ID'           => (int) $city_id,
        'post_content' => '',
    ]);
    $shortcode_rendered = do_shortcode(sprintf(
        '[st_recent_jobs service="%s" location="%s" count="2" heading="Shortcode Jobs" intro="Custom local proof from reviewed jobs."]',
        esc_attr($service_slug),
        esc_attr($location_slug)
    ));
    st_test_assert(
        2 === substr_count($shortcode_rendered, 'st-recent-jobs__card') &&
        false !== strpos($shortcode_rendered, 'Shortcode Jobs') &&
        false !== strpos($shortcode_rendered, 'Custom local proof from reviewed jobs.'),
        'Recent jobs shortcode did not render the requested job cards and custom intro.'
    );
    $shortcode_schemas = st_test_json_ld_scripts($shortcode_rendered);
    st_test_assert(
        'ItemList' === (($shortcode_schemas[0] ?? [])['@type'] ?? ''),
        'Recent jobs shortcode did not reuse the ItemList JSON-LD renderer.'
    );

    $approved_id = end($created_posts);
    global $post;
    $post = get_post($approved_id);
    setup_postdata($post);
    $details_rendered = do_blocks((string) get_post_field('post_content', $approved_id));
    wp_reset_postdata();
    $details_schemas = st_test_json_ld_scripts($details_rendered);
    $service_schema = $details_schemas[0] ?? [];
    st_test_assert(
        'Service' === ($service_schema['@type'] ?? '') &&
        false !== strpos((string) ($service_schema['description'] ?? ''), 'Integration job number 4') &&
        'Newark Integration Test' === ($service_schema['areaServed']['address']['addressLocality'] ?? ''),
        'Job details block did not emit local Service JSON-LD.'
    );
    wp_update_post([
        'ID'           => $approved_id,
        'post_excerpt' => 'Approved editorial copy',
    ]);
    $approved_content = (string) get_post_field('post_content', $approved_id);
    $approved_permalink = get_permalink($approved_id);
    $approved_date = get_post_meta($approved_id, 'st_job_date', true);
    $approved_service_terms = wp_get_post_terms($approved_id, 'st_service', ['fields' => 'ids']);
    $approved_location_terms = wp_get_post_terms($approved_id, 'st_location', ['fields' => 'ids']);
    $changed = [
        'source_tenant_id' => 'tenant-integration',
        'job_id'       => $run_token . '-4',
        'job_number'   => 'INTEGRATION-4',
        'completed_on' => '2026-07-15T12:00:00Z',
        'total'        => 999,
        'city'         => 'Trenton Integration Test',
        'state'        => 'NJ',
        'location_slug'=> 'trenton-integration-test',
        'location_id'  => 'location-updated',
        'job_type_id'  => 'type-updated',
        'service_slug' => 'hvac-integration-test',
        'service_name' => 'HVAC Integration Test',
        'summary'      => 'This generated update must not replace approved editorial copy.',
        'sync_hash'    => hash('sha256', $run_token . '-4-changed'),
    ];
    $changed_request = st_test_request($changed, $test_site);
    $api->upsert_job($changed_request);
    st_test_assert(
        $approved_content === get_post_field('post_content', $approved_id),
        'A repeat sync overwrote published editorial content.'
    );
    st_test_assert('publish' === get_post_status($approved_id), 'A repeat sync removed published status.');
    st_test_assert($approved_permalink === get_permalink($approved_id), 'A repeat sync changed the approved permalink.');
    st_test_assert($approved_date === get_post_meta($approved_id, 'st_job_date', true), 'A repeat sync changed the approved display date.');
    st_test_assert(
        $approved_service_terms === wp_get_post_terms($approved_id, 'st_service', ['fields' => 'ids']),
        'A repeat sync moved the approved post to another service.'
    );
    st_test_assert(
        $approved_location_terms === wp_get_post_terms($approved_id, 'st_location', ['fields' => 'ids']),
        'A repeat sync moved the approved post to another location.'
    );
    st_test_assert(
        '1' === get_post_meta($approved_id, 'st_job_update_available', true),
        'A source change was not flagged for editorial review.'
    );
    st_test_assert(
        $changed['summary'] === get_post_meta($approved_id, 'st_job_pending_summary', true) &&
        $changed['city'] === get_post_meta($approved_id, 'st_job_pending_city', true) &&
        $changed['service_name'] === get_post_meta($approved_id, 'st_job_pending_service_name', true) &&
        $changed['location_id'] === get_post_meta($approved_id, 'st_job_pending_location_id', true),
        'Changed source details were not saved for editorial comparison.'
    );
    $admin = new ST_Sync_Admin();
    ob_start();
    $admin->render_job_update_meta_box(get_post($approved_id));
    $source_update_box = (string) ob_get_clean();
    st_test_assert(
        false !== strpos($source_update_box, 'Current reviewed value') &&
        false !== strpos($source_update_box, 'Incoming ServiceTitan value') &&
        false !== strpos($source_update_box, 'Approved editorial copy') &&
        false !== strpos($source_update_box, $changed['summary']),
        'Source update meta box did not compare current and incoming values.'
    );
    $admin_columns = $admin->job_list_columns([
        'cb'    => '<input type="checkbox">',
        'title' => 'Title',
        'date'  => 'Date',
    ]);
    st_test_assert(
        isset($admin_columns['st_job_completed'], $admin_columns['st_job_service_location'], $admin_columns['st_job_source_update']),
        'Local Jobs admin columns did not include review metadata.'
    );
    $sortable_columns = $admin->sortable_job_list_columns([]);
    st_test_assert(
        'st_job_completed' === ($sortable_columns['st_job_completed'] ?? ''),
        'Local Jobs completed-date column was not sortable.'
    );
    ob_start();
    $admin->render_job_list_column('st_job_source_update', $approved_id);
    $source_update_column = (string) ob_get_clean();
    st_test_assert(
        false !== strpos($source_update_column, 'Review update'),
        'Local Jobs admin source-update column did not flag a pending source change.'
    );
    ob_start();
    $admin->render_job_list_filters('st_job');
    $filter_markup = (string) ob_get_clean();
    st_test_assert(
        false !== strpos($filter_markup, 'st_sync_source_update'),
        'Local Jobs admin list did not render the source-update filter.'
    );
    $apply_result = $admin->apply_pending_job_update($approved_id);
    st_test_assert(! is_wp_error($apply_result), 'Applying a reviewed source update failed.');
    st_test_assert('publish' === get_post_status($approved_id), 'Applying a reviewed update changed the post status.');
    st_test_assert(
        $changed['summary'] === get_post_field('post_excerpt', $approved_id),
        'Applying a reviewed update did not update the generated excerpt.'
    );
    st_test_assert($changed['completed_on'] === get_post_meta($approved_id, 'st_job_date', true), 'Applying a reviewed update did not update the job date.');
    st_test_assert((float) $changed['total'] === (float) get_post_meta($approved_id, 'st_job_price', true), 'Applying a reviewed update did not update the job total.');
    st_test_assert('0' === get_post_meta($approved_id, 'st_job_update_available', true), 'Applying a reviewed update did not clear the update flag.');
    st_test_assert('' === get_post_meta($approved_id, 'st_job_pending_summary', true), 'Applying a reviewed update did not clear pending source details.');
    st_test_assert(
        has_block('st-sync/job-details', (string) get_post_field('post_content', $approved_id)),
        'Applying a reviewed update removed the default Job Details block.'
    );
    $post = get_post($approved_id);
    setup_postdata($post);
    $applied_rendered = do_blocks((string) get_post_field('post_content', $approved_id));
    wp_reset_postdata();
    st_test_assert(
        false !== strpos($applied_rendered, $changed['summary']),
        'Applying a reviewed update did not update the rendered Job Details block.'
    );
    $updated_service_term = get_term_by('slug', $changed['service_slug'], 'st_service');
    $updated_location_term = get_term_by('slug', $changed['location_slug'], 'st_location');
    st_test_assert($updated_service_term && $updated_location_term, 'Applying a reviewed update did not create updated terms.');
    $created_terms[] = ['id' => (int) $updated_service_term->term_id, 'taxonomy' => 'st_service'];
    $created_terms[] = ['id' => (int) $updated_location_term->term_id, 'taxonomy' => 'st_location'];
    st_test_assert(
        in_array((int) $updated_service_term->term_id, wp_get_post_terms($approved_id, 'st_service', ['fields' => 'ids']), true) &&
        in_array((int) $updated_location_term->term_id, wp_get_post_terms($approved_id, 'st_location', ['fields' => 'ids']), true),
        'Applying a reviewed update did not move the post to the reviewed service/location.'
    );

    $bad_hash = $changed;
    $bad_hash['job_id'] = $run_token . '-bad-hash';
    $bad_hash['job_number'] = 'INTEGRATION-BAD-HASH';
    $bad_hash['sync_hash'] = 'not-a-sha256';
    st_test_assert(
        is_wp_error($api->upsert_job(st_test_request($bad_hash, $test_site))),
        'An invalid sync_hash was accepted.'
    );

    $pending_payload = [
        'source_tenant_id' => 'tenant-integration',
        'job_id'       => $run_token . '-pending',
        'job_number'   => 'INTEGRATION-PENDING',
        'completed_on' => '2026-07-20T12:00:00Z',
        'total'        => 700,
        'city'         => 'Newark Integration Test',
        'state'        => 'NJ',
        'location_slug'=> $location_slug,
        'service_slug' => $service_slug,
        'service_name' => 'Plumbing Integration Test',
        'summary'      => 'Initial generated pending-review copy.',
        'sync_hash'    => hash('sha256', $run_token . '-pending'),
    ];
    $pending_request = st_test_request($pending_payload, $test_site);
    $pending_response = $api->upsert_job($pending_request);
    $pending_id = (int) $pending_response->get_data()['id'];
    $created_posts[] = $pending_id;
    wp_update_post([
        'ID'           => $pending_id,
        'post_title'   => 'Editor pending title',
        'post_content' => '<p>Editor pending copy.</p>',
        'post_excerpt' => 'Editor pending excerpt.',
    ]);
    $pending_payload['summary'] = 'A later sync must not replace pending editor work.';
    $pending_payload['sync_hash'] = hash('sha256', $run_token . '-pending-changed');
    $pending_changed_request = st_test_request($pending_payload, $test_site);
    $api->upsert_job($pending_changed_request);
    st_test_assert('pending' === get_post_status($pending_id), 'Pending review status was changed by a repeat sync.');
    st_test_assert(
        'Editor pending title' === get_the_title($pending_id) &&
        false !== strpos((string) get_post_field('post_content', $pending_id), 'Editor pending copy'),
        'A repeat sync overwrote pending editorial work.'
    );

    $post_type = get_post_type_object('st_job');
    st_test_assert(
        $post_type && 'do_not_allow' === $post_type->cap->create_posts,
        'Core WordPress job creation was not disabled.'
    );

    $invalid_request = st_test_request($changed, $test_site);
    $invalid_request->set_header('x-st-signature', 'v1=' . str_repeat('0', 64));
    st_test_assert(
        is_wp_error($api->verify_delivery_signature($invalid_request)),
        'An invalid delivery signature was accepted.'
    );

    $service_requests = [];
    $http_mock = static function ($preempt, $args, $url) use (&$service_requests, $run_token) {
        unset($preempt);
        $path = (string) wp_parse_url($url, PHP_URL_PATH);
        $service_requests[] = [
            'method' => $args['method'],
            'path'   => $path,
            'body'   => isset($args['body']) ? json_decode((string) $args['body'], true) : null,
        ];
        $payload = [];
        $status = 200;
        if ('/v1/licenses/activate' === $path) {
            $status = 201;
            $payload = [
                'site_id'          => 'hosted-site-' . $run_token,
                'activation_token' => 'activation-token-' . $run_token,
                'signing_secret'   => 'signing-secret-' . $run_token,
                'entitlement'      => [
                    'eligible'           => true,
                    'status'             => 'active',
                    'plan'               => 'monthly',
                    'current_period_end' => '2026-08-01T00:00:00Z',
                ],
            ];
        } elseif ('/v1/billing/checkout' === $path) {
            $status = 201;
            $payload = [
                'checkout_url'        => 'https://checkout.stripe.test/session/' . $run_token,
                'checkout_session_id' => 'cs_' . $run_token,
                'license_key'         => 'checkout-license-key-must-not-be-stored',
                'plan'                => (string) ($service_requests[count($service_requests) - 1]['body']['plan'] ?? 'monthly'),
            ];
        } elseif ('/v1/licenses/status' === $path) {
            $payload = [
                'site_id' => 'hosted-site-' . $run_token,
                'site_url'=> home_url('/'),
                'entitlement' => [
                    'eligible'           => true,
                    'status'             => 'active',
                    'plan'               => 'monthly',
                    'current_period_end' => '2026-08-01T00:00:00Z',
                ],
                'connection' => [
                    'connected'   => true,
                    'tenant_id'   => '123456',
                    'environment' => 'integration',
                    'updated_at'  => '2026-07-07T12:01:00.000Z',
                ],
                'sync' => [
                    'last_successful_sync_at' => '2026-07-07T12:00:00.000Z',
                    'last_sync_attempt_at'    => '2026-07-07T12:05:00.000Z',
                    'last_sync_status'        => 'failed',
                    'last_sync_error'         => 'Delivery refused by WordPress',
                    'last_sync_stats'         => [
                        'sites'    => 1,
                        'imported' => 2,
                        'filtered' => 3,
                        'failed'   => 1,
                    ],
                ],
            ];
        } elseif ('/v1/connections/servicetitan' === $path) {
            $payload = [
                'connected'   => true,
                'tenant_id'   => '123456',
                'environment' => 'integration',
                'updated_at'  => '2026-07-07T12:01:00.000Z',
            ];
        } elseif ('/v1/sites/policy' === $path) {
            $payload = ['updated' => true];
        } elseif ('/v1/billing/portal' === $path) {
            $payload = ['portal_url' => 'https://billing.stripe.test/session/' . $run_token];
        } elseif ('/v1/licenses/activation' === $path) {
            $payload = ['revoked' => true];
        }

        return [
            'headers'  => [],
            'body'     => wp_json_encode($payload),
            'response' => ['code' => $status, 'message' => 'OK'],
            'cookies'  => [],
            'filename' => null,
        ];
    };
    add_filter('pre_http_request', $http_mock, 10, 3);

    $service_client = new ST_Sync_Service_Client();
    $checkout = $service_client->checkout('Owner@Example.com', 'yearly');
    st_test_assert(
        ! is_wp_error($checkout) &&
        isset($checkout['checkout_url'], $checkout['license_key']) &&
        0 === strpos((string) $checkout['checkout_url'], 'https://checkout.stripe.test/session/'),
        'Hosted checkout creation failed.'
    );
    $checkout_request = array_values(array_filter($service_requests, static function ($request): bool {
        return '/v1/billing/checkout' === $request['path'];
    }))[0] ?? null;
    st_test_assert(
        is_array($checkout_request) &&
        'POST' === $checkout_request['method'] &&
        'owner@example.com' === ($checkout_request['body']['email'] ?? '') &&
        'yearly' === ($checkout_request['body']['plan'] ?? ''),
        'Hosted checkout did not send the normalized billing request.'
    );

    $activation = $service_client->activate('license-key-must-not-be-stored');
    st_test_assert(! is_wp_error($activation) && $service_client->is_connected(), 'Hosted license activation failed.');
    $activation_request = array_values(array_filter($service_requests, static function ($request): bool {
        return '/v1/licenses/activate' === $request['path'];
    }))[0] ?? null;
    st_test_assert(
        is_array($activation_request) &&
        isset($activation_request['body']['policy']['min_summary_words']),
        'Hosted activation did not send the initial content policy.'
    );
    $connection = $service_client->connect_servicetitan([
        'tenant_id'    => '123456',
        'client_id'    => 'client-id',
        'client_secret'=> 'client-secret-must-not-be-stored',
        'environment'  => 'integration',
    ]);
    st_test_assert(! is_wp_error($connection), 'Hosted ServiceTitan connection failed.');
    $connected_site = get_option('st_sync_site', []);
    st_test_assert(
        isset($connected_site['connection']['connected'], $connected_site['connection']['environment']) &&
        true === $connected_site['connection']['connected'] &&
        'integration' === $connected_site['connection']['environment'],
        'Hosted ServiceTitan connection status was not cached after save.'
    );
    st_test_assert(! is_wp_error($service_client->status()), 'Hosted entitlement refresh failed.');
    $cached_site = get_option('st_sync_site', []);
    st_test_assert(
        isset($cached_site['connection']['connected'], $cached_site['connection']['tenant_id']) &&
        true === $cached_site['connection']['connected'] &&
        '123456' === $cached_site['connection']['tenant_id'],
        'Hosted ServiceTitan connection status was not refreshed locally.'
    );
    st_test_assert(
        isset($cached_site['sync']['last_sync_status'], $cached_site['sync']['last_sync_stats']['failed']) &&
        'failed' === $cached_site['sync']['last_sync_status'] &&
        1 === (int) $cached_site['sync']['last_sync_stats']['failed'],
        'Hosted sync health was not cached locally.'
    );
    if (class_exists('ST_Sync_Admin')) {
        ob_start();
        (new ST_Sync_Admin())->render_settings_page();
        $settings_html = (string) ob_get_clean();
        st_test_assert(
            false !== strpos($settings_html, 'Sync health') &&
            false !== strpos($settings_html, 'Editorial queue') &&
            false !== strpos($settings_html, 'Review pending jobs') &&
            false !== strpos($settings_html, 'Review source updates') &&
            false !== strpos($settings_html, 'ServiceTitan connection') &&
            false !== strpos($settings_html, 'Connected') &&
            false !== strpos($settings_html, 'Delivery refused by WordPress'),
            'Hosted connection, sync health, and editorial queue were not rendered in the admin settings page.'
        );
    }
    st_test_assert(! is_wp_error($service_client->update_policy(class_exists('ST_Sync_Admin') ? ST_Sync_Admin::defaults() : [])), 'Hosted policy update failed.');
    $portal = $service_client->billing_portal();
    st_test_assert(
        ! is_wp_error($portal) &&
        isset($portal['portal_url']) &&
        0 === strpos((string) $portal['portal_url'], 'https://billing.stripe.test/session/'),
        'Hosted billing portal creation failed.'
    );

    $stored_site = serialize(get_option('st_sync_site', []));
    st_test_assert(
        false === strpos($stored_site, 'license-key-must-not-be-stored') &&
        false === strpos($stored_site, 'checkout-license-key-must-not-be-stored') &&
        false === strpos($stored_site, 'client-secret-must-not-be-stored'),
        'License or ServiceTitan credentials were persisted in WordPress.'
    );
    st_test_assert(! is_wp_error($service_client->deactivate()), 'Hosted site deactivation failed.');
    st_test_assert(false === get_option('st_sync_site', false), 'Deactivation did not remove local delivery credentials.');
    remove_filter('pre_http_request', $http_mock, 10);

} catch (Throwable $error) {
    $failure = $error;
} finally {
    wp_set_current_user((int) $admins[0]);
    foreach (array_reverse(array_unique($created_posts)) as $post_id) {
        wp_delete_post((int) $post_id, true);
    }
    foreach ($created_terms as $term) {
        wp_delete_term($term['id'], $term['taxonomy']);
    }
    if ($had_site_option) {
        update_option('st_sync_site', $previous_site_option, false);
    } else {
        delete_option('st_sync_site');
    }
    if ($had_sync_options) {
        update_option('st_sync_options', is_array($previous_sync_options) ? $previous_sync_options : []);
    } else {
        delete_option('st_sync_options');
    }
}

if ($failure instanceof Throwable) {
    fwrite(STDERR, 'Integration failure: ' . $failure->getMessage() . "\n");
    exit(1);
}

echo "WordPress integration checks passed.\n";
