<?php
/**
 * Subscription, connection, and content-policy administration.
 */

if (! defined('ABSPATH')) {
    exit;
}

class ST_Sync_Admin
{
    public function __construct()
    {
        add_action('admin_menu', [$this, 'add_plugin_admin_menu']);
        add_action('admin_init', [$this, 'register_st_settings']);
        add_action('admin_post_st_sync_checkout', [$this, 'start_checkout']);
        add_action('admin_post_st_sync_activate', [$this, 'activate_site']);
        add_action('admin_post_st_sync_connect', [$this, 'connect_servicetitan']);
        add_action('admin_post_st_sync_refresh', [$this, 'refresh_status']);
        add_action('admin_post_st_sync_billing_portal', [$this, 'open_billing_portal']);
        add_action('admin_post_st_sync_deactivate', [$this, 'deactivate_site']);
        add_action('admin_post_st_sync_create_location_page', [$this, 'create_location_page_action']);
        add_action('add_meta_boxes_st_job', [$this, 'add_job_update_meta_box']);
        add_action('admin_post_st_sync_apply_job_update', [$this, 'apply_job_update_action']);
        add_action('admin_post_st_sync_dismiss_job_update', [$this, 'dismiss_job_update_action']);
        add_filter('manage_st_job_posts_columns', [$this, 'job_list_columns']);
        add_action('manage_st_job_posts_custom_column', [$this, 'render_job_list_column'], 10, 2);
        add_filter('manage_edit-st_job_sortable_columns', [$this, 'sortable_job_list_columns']);
        add_action('restrict_manage_posts', [$this, 'render_job_list_filters']);
        add_action('pre_get_posts', [$this, 'filter_job_list_query']);
        add_action('update_option_st_sync_options', [$this, 'sync_policy'], 10, 2);
    }

    public static function defaults(): array
    {
        return [
            'min_price'              => '0',
            'jobs_since'             => gmdate('Y-m-d', strtotime('-7 days')),
            'min_summary_words'      => '5',
            'completion_custom_field'=> '',
            'default_service_slug'   => '',
            'service_mappings'       => '',
            'allowed_cities'         => '',
            'excluded_job_types'     => '',
            'recent_jobs_count'      => '3',
            'auto_append_recent_jobs'=> '1',
        ];
    }

    public function add_plugin_admin_menu(): void
    {
        add_menu_page(
            __('ServiceTitan Local Jobs', 'service-titan-job-post'),
            __('Local Jobs Sync', 'service-titan-job-post'),
            'manage_options',
            'st-sync-settings',
            [$this, 'render_settings_page'],
            'dashicons-location-alt'
        );
    }

    public function register_st_settings(): void
    {
        register_setting('st_sync_group', 'st_sync_options', [
            'type'              => 'array',
            'sanitize_callback' => [$this, 'sanitize_options'],
            'default'           => self::defaults(),
        ]);

        add_settings_section(
            'st_filter_section',
            __('Content and filtering', 'service-titan-job-post'),
            '__return_false',
            'st-sync-settings'
        );
        $this->add_field('jobs_since', __('Initial backfill date', 'service-titan-job-post'), 'date');
        $this->add_field('min_price', __('Minimum job total ($)', 'service-titan-job-post'), 'number');
        $this->add_field('min_summary_words', __('Minimum completion-detail words', 'service-titan-job-post'), 'number');
        $this->add_field(
            'completion_custom_field',
            __('Completion custom field', 'service-titan-job-post'),
            'text',
            __('Optional ServiceTitan custom-field name or type ID used when Summary of Work is unavailable.', 'service-titan-job-post')
        );
        $this->add_field(
            'default_service_slug',
            __('Default service slug', 'service-titan-job-post'),
            'text',
            __('Optional fallback for single-trade sites. Leave blank to quarantine unclassified jobs.', 'service-titan-job-post')
        );
        $this->add_field(
            'service_mappings',
            __('Service mappings', 'service-titan-job-post'),
            'textarea',
            __('One per line, such as “123456=plumbing”. Stable Job Type IDs are preferred.', 'service-titan-job-post')
        );
        $this->add_field(
            'allowed_cities',
            __('Allowed cities', 'service-titan-job-post'),
            'textarea',
            __('Optional comma- or line-separated allowlist.', 'service-titan-job-post')
        );
        $this->add_field(
            'excluded_job_types',
            __('Excluded job types', 'service-titan-job-post'),
            'textarea',
            __('Optional comma- or line-separated exact Job Type names.', 'service-titan-job-post')
        );
        $this->add_field('recent_jobs_count', __('Jobs shown on location pages', 'service-titan-job-post'), 'number');
        $this->add_field(
            'auto_append_recent_jobs',
            __('Automatically show on location pages', 'service-titan-job-post'),
            'checkbox',
            __('Append Recent Local Jobs to matching nested Pages, such as plumbing/newark, unless the page already contains the block or shortcode.', 'service-titan-job-post')
        );
    }

    public function sanitize_options($input): array
    {
        $input = is_array($input) ? $input : [];

        return [
            'min_price'               => (string) max(0, (float) ($input['min_price'] ?? 0)),
            'jobs_since'              => $this->sanitize_date((string) ($input['jobs_since'] ?? '')),
            'min_summary_words'       => (string) min(100, max(1, (int) ($input['min_summary_words'] ?? 5))),
            'completion_custom_field' => sanitize_text_field((string) ($input['completion_custom_field'] ?? '')),
            'default_service_slug'    => sanitize_title((string) ($input['default_service_slug'] ?? '')),
            'service_mappings'        => sanitize_textarea_field((string) ($input['service_mappings'] ?? '')),
            'allowed_cities'          => sanitize_textarea_field((string) ($input['allowed_cities'] ?? '')),
            'excluded_job_types'      => sanitize_textarea_field((string) ($input['excluded_job_types'] ?? '')),
            'recent_jobs_count'       => (string) min(12, max(1, (int) ($input['recent_jobs_count'] ?? 3))),
            'auto_append_recent_jobs' => empty($input['auto_append_recent_jobs']) ? '0' : '1',
        ];
    }

    public function render_field(array $args): void
    {
        $options = wp_parse_args(get_option('st_sync_options', []), self::defaults());
        $id = (string) $args['id'];
        $type = (string) $args['type'];
        $value = (string) ($options[$id] ?? '');
        $name = 'st_sync_options[' . $id . ']';

        if ('checkbox' === $type) {
            echo '<input type="hidden" name="' . esc_attr($name) . '" value="0">';
            echo '<label><input type="checkbox" name="' . esc_attr($name) . '" value="1" ' . checked('1', $value, false) . '> ' . esc_html__('Enabled', 'service-titan-job-post') . '</label>';
        } elseif ('textarea' === $type) {
            echo '<textarea name="' . esc_attr($name) . '" class="large-text" rows="4">' . esc_textarea($value) . '</textarea>';
        } else {
            echo '<input type="' . esc_attr($type) . '" name="' . esc_attr($name) . '" value="' . esc_attr($value) . '" class="regular-text">';
        }

        if (! empty($args['description'])) {
            echo '<p class="description">' . esc_html($args['description']) . '</p>';
        }
    }

    public function render_settings_page(): void
    {
        if (! current_user_can('manage_options')) {
            return;
        }

        $client = new ST_Sync_Service_Client();
        $site = $client->site();
        $entitlement = is_array($site['entitlement'] ?? null) ? $site['entitlement'] : [];
        $connected = $client->is_connected();
        $notice = get_transient('st_sync_admin_notice_' . get_current_user_id());
        if ($notice) {
            delete_transient('st_sync_admin_notice_' . get_current_user_id());
        }
        ?>
        <div class="wrap">
            <h1><?php esc_html_e('ServiceTitan Local Job Content', 'service-titan-job-post'); ?></h1>

            <?php if (is_array($notice)) : ?>
                <div class="notice notice-<?php echo esc_attr($notice['type']); ?> is-dismissible">
                    <p><?php echo esc_html($notice['message']); ?></p>
                </div>
            <?php endif; ?>
            <?php if (get_option('st_sync_policy_dirty')) : ?>
                <div class="notice notice-warning"><p>
                    <?php esc_html_e('Content policy changes are saved locally but have not synced to the hosted worker yet. Save again after the hosted service is reachable.', 'service-titan-job-post'); ?>
                </p></div>
            <?php endif; ?>
            <?php if ($this->uses_plain_permalinks()) : ?>
                <div class="notice notice-warning"><p>
                    <?php
                    printf(
                        /* translators: %s: Permalink settings URL */
                        wp_kses_post(__('Local Job URLs need a non-Plain permalink structure. <a href="%s">Open Permalink Settings</a> and choose a pretty permalink format before publishing job pages.', 'service-titan-job-post')),
                        esc_url(admin_url('options-permalink.php'))
                    );
                    ?>
                </p></div>
            <?php endif; ?>

            <?php if (! $client->is_configured()) : ?>
                <div class="notice notice-error"><p>
                    <?php esc_html_e('This build does not have a hosted service URL configured.', 'service-titan-job-post'); ?>
                </p></div>
            <?php elseif (! $connected) : ?>
                <h2><?php esc_html_e('Start subscription', 'service-titan-job-post'); ?></h2>
                <p><?php esc_html_e('Create a monthly or yearly subscription, then return with the issued license key to activate this site.', 'service-titan-job-post'); ?></p>
                <form action="<?php echo esc_url(admin_url('admin-post.php')); ?>" method="post">
                    <input type="hidden" name="action" value="st_sync_checkout">
                    <?php wp_nonce_field('st_sync_checkout'); ?>
                    <table class="form-table"><tbody>
                        <tr>
                            <th><label for="st-checkout-email"><?php esc_html_e('Billing email', 'service-titan-job-post'); ?></label></th>
                            <td><input id="st-checkout-email" type="email" name="billing_email" class="regular-text" value="<?php echo esc_attr((string) get_option('admin_email')); ?>" required></td>
                        </tr>
                        <tr>
                            <th><label for="st-checkout-plan"><?php esc_html_e('Plan', 'service-titan-job-post'); ?></label></th>
                            <td>
                                <select id="st-checkout-plan" name="plan">
                                    <option value="monthly"><?php esc_html_e('Monthly', 'service-titan-job-post'); ?></option>
                                    <option value="yearly"><?php esc_html_e('Yearly', 'service-titan-job-post'); ?></option>
                                </select>
                            </td>
                        </tr>
                    </tbody></table>
                    <?php submit_button(__('Start checkout', 'service-titan-job-post')); ?>
                </form>

                <h2><?php esc_html_e('Activate subscription', 'service-titan-job-post'); ?></h2>
                <p><?php esc_html_e('Activation is validated by the hosted service. Editing this plugin cannot make the hosted worker deliver jobs without an eligible subscription.', 'service-titan-job-post'); ?></p>
                <form action="<?php echo esc_url(admin_url('admin-post.php')); ?>" method="post">
                    <input type="hidden" name="action" value="st_sync_activate">
                    <?php wp_nonce_field('st_sync_activate'); ?>
                    <label for="st-license-key"><?php esc_html_e('License key', 'service-titan-job-post'); ?></label>
                    <input id="st-license-key" type="password" name="license_key" class="regular-text" required autocomplete="off">
                    <?php submit_button(__('Activate site', 'service-titan-job-post')); ?>
                </form>
            <?php else : ?>
                <?php $this->render_subscription_status($site, $entitlement); ?>
                <?php $this->render_editorial_queue_status(); ?>
                <?php $this->render_location_page_coverage(); ?>
                <?php $this->render_connection_form(is_array($site['connection'] ?? null) ? $site['connection'] : []); ?>

                <form action="options.php" method="post">
                    <?php
                    settings_fields('st_sync_group');
                    do_settings_sections('st-sync-settings');
                    submit_button(__('Save content policy', 'service-titan-job-post'));
                    ?>
                </form>

                <h2><?php esc_html_e('Disconnect site', 'service-titan-job-post'); ?></h2>
                <p><?php esc_html_e('Disconnecting or canceling stops future deliveries. Existing WordPress job posts remain untouched.', 'service-titan-job-post'); ?></p>
                <form action="<?php echo esc_url(admin_url('admin-post.php')); ?>" method="post">
                    <input type="hidden" name="action" value="st_sync_deactivate">
                    <?php wp_nonce_field('st_sync_deactivate'); ?>
                    <?php submit_button(__('Disconnect site', 'service-titan-job-post'), 'secondary'); ?>
                </form>
            <?php endif; ?>
        </div>
        <?php
    }

    public function start_checkout(): void
    {
        $this->authorize_action('st_sync_checkout');
        $email = isset($_POST['billing_email']) ? sanitize_email(wp_unslash($_POST['billing_email'])) : '';
        $plan = isset($_POST['plan']) ? sanitize_key(wp_unslash($_POST['plan'])) : 'monthly';
        $result = (new ST_Sync_Service_Client())->checkout($email, $plan);
        if (is_wp_error($result)) {
            $this->redirect_with_result($result, '');
        }

        $checkout_url = esc_url_raw((string) ($result['checkout_url'] ?? ''));
        $scheme = (string) wp_parse_url($checkout_url, PHP_URL_SCHEME);
        $license_key = sanitize_text_field((string) ($result['license_key'] ?? ''));
        if ('https' !== $scheme || '' === $license_key) {
            $this->set_notice('error', __('The hosted service returned an invalid checkout response.', 'service-titan-job-post'));
            wp_safe_redirect(admin_url('admin.php?page=st-sync-settings'));
            exit;
        }

        $this->render_checkout_interstitial($license_key, $checkout_url);
    }

    public function activate_site(): void
    {
        $this->authorize_action('st_sync_activate');
        $license_key = isset($_POST['license_key']) ? trim((string) wp_unslash($_POST['license_key'])) : '';
        $result = (new ST_Sync_Service_Client())->activate($license_key);
        $this->redirect_with_result($result, __('Site activated.', 'service-titan-job-post'));
    }

    public function connect_servicetitan(): void
    {
        $this->authorize_action('st_sync_connect');
        $connection = [
            'environment'   => isset($_POST['environment']) ? sanitize_key(wp_unslash($_POST['environment'])) : 'production',
            'tenant_id'     => isset($_POST['tenant_id']) ? sanitize_text_field(wp_unslash($_POST['tenant_id'])) : '',
            'client_id'     => isset($_POST['client_id']) ? trim((string) wp_unslash($_POST['client_id'])) : '',
            'client_secret' => isset($_POST['client_secret']) ? trim((string) wp_unslash($_POST['client_secret'])) : '',
        ];
        $result = (new ST_Sync_Service_Client())->connect_servicetitan($connection);
        $this->redirect_with_result($result, __('ServiceTitan connection saved securely.', 'service-titan-job-post'));
    }

    public function refresh_status(): void
    {
        $this->authorize_action('st_sync_refresh');
        $result = (new ST_Sync_Service_Client())->status();
        $this->redirect_with_result($result, __('Subscription status refreshed.', 'service-titan-job-post'));
    }

    public function open_billing_portal(): void
    {
        $this->authorize_action('st_sync_billing_portal');
        $result = (new ST_Sync_Service_Client())->billing_portal();
        if (is_wp_error($result)) {
            $this->redirect_with_result($result, '');
        }

        $portal_url = esc_url_raw((string) ($result['portal_url'] ?? ''));
        $scheme = (string) wp_parse_url($portal_url, PHP_URL_SCHEME);
        if ('https' !== $scheme) {
            $this->set_notice('error', __('The hosted service returned an invalid billing portal URL.', 'service-titan-job-post'));
            wp_safe_redirect(admin_url('admin.php?page=st-sync-settings'));
            exit;
        }

        wp_redirect($portal_url);
        exit;
    }

    public function deactivate_site(): void
    {
        $this->authorize_action('st_sync_deactivate');
        $result = (new ST_Sync_Service_Client())->deactivate();
        $this->redirect_with_result($result, __('Site disconnected. Existing posts were preserved.', 'service-titan-job-post'));
    }

    public function add_job_update_meta_box(WP_Post $post): void
    {
        if ('1' !== get_post_meta($post->ID, 'st_job_update_available', true)) {
            return;
        }

        add_meta_box(
            'st-sync-source-update',
            __('ServiceTitan source update', 'service-titan-job-post'),
            [$this, 'render_job_update_meta_box'],
            'st_job',
            'normal',
            'high'
        );
    }

    public function render_job_update_meta_box(WP_Post $post): void
    {
        $pending = $this->pending_job_update($post->ID);
        if (empty($pending)) {
            echo '<p>' . esc_html__('No pending source update is available.', 'service-titan-job-post') . '</p>';
            return;
        }

        $current = $this->current_job_update_values($post->ID);
        $rows = [
            [
                'label'    => __('Summary', 'service-titan-job-post'),
                'current'  => $current['summary'],
                'incoming' => $pending['summary'],
            ],
            [
                'label'    => __('Completed on', 'service-titan-job-post'),
                'current'  => $current['completed_on'],
                'incoming' => $pending['completed_on'],
            ],
            [
                'label'    => __('City', 'service-titan-job-post'),
                'current'  => $current['city'],
                'incoming' => $pending['city'],
            ],
            [
                'label'    => __('State', 'service-titan-job-post'),
                'current'  => $current['state'],
                'incoming' => $pending['state'],
            ],
            [
                'label'    => __('Service', 'service-titan-job-post'),
                'current'  => $current['service_name'],
                'incoming' => $pending['service_name'],
            ],
            [
                'label'    => __('Location slug', 'service-titan-job-post'),
                'current'  => $current['location_slug'],
                'incoming' => $pending['location_slug'],
            ],
            [
                'label'    => __('Job type', 'service-titan-job-post'),
                'current'  => $current['job_type_name'],
                'incoming' => $pending['job_type_name'],
            ],
        ];
        ?>
        <p><?php esc_html_e('ServiceTitan has newer source data for this job. Automation preserved the current editorial copy; apply this update only after review.', 'service-titan-job-post'); ?></p>
        <table class="widefat striped">
            <thead>
                <tr>
                    <th scope="col"><?php esc_html_e('Field', 'service-titan-job-post'); ?></th>
                    <th scope="col"><?php esc_html_e('Current reviewed value', 'service-titan-job-post'); ?></th>
                    <th scope="col"><?php esc_html_e('Incoming ServiceTitan value', 'service-titan-job-post'); ?></th>
                </tr>
            </thead>
            <tbody>
            <?php foreach ($rows as $row) : ?>
                <?php if ('' === trim((string) $row['current']) && '' === trim((string) $row['incoming'])) { continue; } ?>
                <tr>
                    <th scope="row"><?php echo esc_html($row['label']); ?></th>
                    <td><?php echo esc_html((string) $row['current']); ?></td>
                    <td><?php echo esc_html((string) $row['incoming']); ?></td>
                </tr>
            <?php endforeach; ?>
        </tbody></table>
        <p>
            <?php $this->render_job_update_button($post->ID, 'st_sync_apply_job_update', __('Apply reviewed update', 'service-titan-job-post'), 'primary'); ?>
            <?php $this->render_job_update_button($post->ID, 'st_sync_dismiss_job_update', __('Dismiss update', 'service-titan-job-post'), 'secondary'); ?>
        </p>
        <?php
    }

    /**
     * @return true|WP_Error
     */
    public function apply_pending_job_update(int $post_id)
    {
        if ('st_job' !== get_post_type($post_id)) {
            return new WP_Error('st_sync_invalid_job', __('This is not a Local Job post.', 'service-titan-job-post'));
        }

        $pending = $this->pending_job_update($post_id);
        if (empty($pending)) {
            return new WP_Error('st_sync_no_pending_update', __('No pending source update is available.', 'service-titan-job-post'));
        }

        $summary = sanitize_textarea_field($pending['summary']);
        $city = sanitize_text_field($pending['city']);
        $state = sanitize_text_field($pending['state']);
        $service_slug = sanitize_title($pending['service_slug']);
        $service_name = sanitize_text_field($pending['service_name']);
        if ('' === $service_name && '' !== $service_slug) {
            $service_name = $this->title_from_slug($service_slug);
        }
        $location_slug = sanitize_title($pending['location_slug']);
        $job_type_name = sanitize_text_field($pending['job_type_name']);

        $post_data = ['ID' => $post_id];
        if ('' !== $summary) {
            $post_data['post_excerpt'] = $summary;
            if (! $this->has_job_details_block($post_id)) {
                $post_data['post_content'] = wpautop(esc_html($summary));
            }
        }
        if ('' !== $job_type_name && '' !== $city) {
            $post_data['post_title'] = sprintf('%s in %s', $job_type_name, $city);
        }

        $updated = wp_update_post($post_data, true);
        if (is_wp_error($updated)) {
            return $updated;
        }

        if ('' !== $summary) {
            update_post_meta($post_id, 'st_job_summary', $summary);
        }
        $meta_map = [
            'st_job_date'        => $pending['completed_on'],
            'st_job_city'        => $city,
            'st_job_state'       => $state,
            'st_job_service'     => $service_name,
            'st_job_location_id' => $pending['location_id'],
            'st_job_type_id'     => $pending['job_type_id'],
            'st_job_type_name'   => $job_type_name,
        ];
        foreach ($meta_map as $key => $value) {
            if ('' !== trim((string) $value)) {
                update_post_meta($post_id, $key, sanitize_text_field((string) $value));
            }
        }
        if ('' !== trim((string) $pending['total']) && is_numeric($pending['total'])) {
            update_post_meta($post_id, 'st_job_price', (float) $pending['total']);
        }

        if ('' !== $service_slug) {
            $service_term = $this->ensure_term($service_name ?: $this->title_from_slug($service_slug), $service_slug, 'st_service');
            if (is_wp_error($service_term)) {
                return $service_term;
            }
            $service_result = wp_set_object_terms($post_id, [(int) $service_term], 'st_service', false);
            if (is_wp_error($service_result)) {
                return $service_result;
            }
        }

        if ('' !== $location_slug) {
            $location_term = $this->ensure_term($city ?: $this->title_from_slug($location_slug), $location_slug, 'st_location');
            if (is_wp_error($location_term)) {
                return $location_term;
            }
            $location_result = wp_set_object_terms($post_id, [(int) $location_term], 'st_location', false);
            if (is_wp_error($location_result)) {
                return $location_result;
            }
        }

        $this->clear_pending_job_update($post_id);
        return true;
    }

    /**
     * @return true|WP_Error
     */
    public function dismiss_pending_job_update(int $post_id)
    {
        if ('st_job' !== get_post_type($post_id)) {
            return new WP_Error('st_sync_invalid_job', __('This is not a Local Job post.', 'service-titan-job-post'));
        }

        $this->clear_pending_job_update($post_id);
        return true;
    }

    public function job_list_columns(array $columns): array
    {
        $next = [];
        foreach ($columns as $key => $label) {
            $next[$key] = $label;
            if ('title' === $key) {
                $next['st_job_completed'] = __('Completed', 'service-titan-job-post');
                $next['st_job_service_location'] = __('Service / Location', 'service-titan-job-post');
                $next['st_job_source_update'] = __('Source update', 'service-titan-job-post');
            }
        }

        return $next;
    }

    public function render_job_list_column(string $column, int $post_id): void
    {
        if ('st_job_completed' === $column) {
            $completed = (string) get_post_meta($post_id, 'st_job_date', true);
            echo esc_html($completed ? $this->format_admin_date($completed) : '—');
            return;
        }

        if ('st_job_service_location' === $column) {
            $service = $this->term_names($post_id, 'st_service');
            $location = $this->term_names($post_id, 'st_location');
            if ('' === $service) {
                $service = (string) get_post_meta($post_id, 'st_job_service', true);
            }
            if ('' === $location) {
                $location = trim(implode(', ', array_filter([
                    (string) get_post_meta($post_id, 'st_job_city', true),
                    (string) get_post_meta($post_id, 'st_job_state', true),
                ])));
            }
            echo esc_html(implode(' / ', array_filter([$service, $location])) ?: '—');
            return;
        }

        if ('st_job_source_update' === $column) {
            if ('1' === get_post_meta($post_id, 'st_job_update_available', true)) {
                echo '<strong class="st-sync-update-available">' . esc_html__('Review update', 'service-titan-job-post') . '</strong>';
            } else {
                echo esc_html__('Current', 'service-titan-job-post');
            }
        }
    }

    public function sortable_job_list_columns(array $columns): array
    {
        $columns['st_job_completed'] = 'st_job_completed';
        return $columns;
    }

    public function render_job_list_filters(string $post_type): void
    {
        if ('st_job' !== $post_type) {
            return;
        }

        $selected = isset($_GET['st_sync_source_update']) ? sanitize_key(wp_unslash($_GET['st_sync_source_update'])) : '';
        ?>
        <label class="screen-reader-text" for="st-sync-source-update-filter"><?php esc_html_e('Filter by source update status', 'service-titan-job-post'); ?></label>
        <select id="st-sync-source-update-filter" name="st_sync_source_update">
            <option value=""><?php esc_html_e('All source updates', 'service-titan-job-post'); ?></option>
            <option value="available" <?php selected($selected, 'available'); ?>><?php esc_html_e('Needs source review', 'service-titan-job-post'); ?></option>
            <option value="current" <?php selected($selected, 'current'); ?>><?php esc_html_e('Current source', 'service-titan-job-post'); ?></option>
        </select>
        <?php
    }

    public function filter_job_list_query(WP_Query $query): void
    {
        if (! is_admin() || ! $query->is_main_query() || 'st_job' !== $query->get('post_type')) {
            return;
        }

        if ('st_job_completed' === $query->get('orderby')) {
            $query->set('meta_key', 'st_job_date');
            $query->set('orderby', 'meta_value');
        }

        $source_update = isset($_GET['st_sync_source_update']) ? sanitize_key(wp_unslash($_GET['st_sync_source_update'])) : '';
        if (! in_array($source_update, ['available', 'current'], true)) {
            return;
        }

        $meta_query = $query->get('meta_query');
        $meta_query = is_array($meta_query) ? $meta_query : [];
        if ('available' === $source_update) {
            $meta_query[] = [
                'key'   => 'st_job_update_available',
                'value' => '1',
            ];
        } else {
            $meta_query[] = [
                'relation' => 'OR',
                [
                    'key'     => 'st_job_update_available',
                    'compare' => 'NOT EXISTS',
                ],
                [
                    'key'     => 'st_job_update_available',
                    'value'   => '1',
                    'compare' => '!=',
                ],
            ];
        }
        $query->set('meta_query', $meta_query);
    }

    public function sync_policy($old_value, $new_value): void
    {
        unset($old_value);
        $client = new ST_Sync_Service_Client();
        if (! $client->is_connected()) {
            return;
        }

        $result = $client->update_policy(is_array($new_value) ? $new_value : []);
        if (is_wp_error($result)) {
            update_option('st_sync_policy_dirty', time(), false);
            $this->set_notice('error', $result->get_error_message());
        } else {
            delete_option('st_sync_policy_dirty');
        }
    }

    private function render_subscription_status(array $site, array $entitlement): void
    {
        $eligible = ! empty($entitlement['eligible']);
        ?>
        <h2><?php esc_html_e('Subscription', 'service-titan-job-post'); ?></h2>
        <table class="widefat striped" style="max-width: 720px">
            <tbody>
                <tr><th><?php esc_html_e('Site ID', 'service-titan-job-post'); ?></th><td><?php echo esc_html((string) ($site['site_id'] ?? '')); ?></td></tr>
                <tr><th><?php esc_html_e('Entitlement', 'service-titan-job-post'); ?></th><td><?php echo esc_html($eligible ? __('Eligible', 'service-titan-job-post') : __('Not eligible', 'service-titan-job-post')); ?></td></tr>
                <tr><th><?php esc_html_e('Status', 'service-titan-job-post'); ?></th><td><?php echo esc_html((string) ($entitlement['status'] ?? 'unknown')); ?></td></tr>
                <tr><th><?php esc_html_e('Plan', 'service-titan-job-post'); ?></th><td><?php echo esc_html((string) ($entitlement['plan'] ?? '')); ?></td></tr>
                <tr><th><?php esc_html_e('Current period ends', 'service-titan-job-post'); ?></th><td><?php echo esc_html((string) ($entitlement['current_period_end'] ?? '')); ?></td></tr>
            </tbody>
        </table>
        <form action="<?php echo esc_url(admin_url('admin-post.php')); ?>" method="post">
            <input type="hidden" name="action" value="st_sync_refresh">
            <?php wp_nonce_field('st_sync_refresh'); ?>
            <?php submit_button(__('Refresh subscription status', 'service-titan-job-post'), 'secondary'); ?>
        </form>
        <form action="<?php echo esc_url(admin_url('admin-post.php')); ?>" method="post">
            <input type="hidden" name="action" value="st_sync_billing_portal">
            <?php wp_nonce_field('st_sync_billing_portal'); ?>
            <?php submit_button(__('Manage billing', 'service-titan-job-post'), 'secondary'); ?>
        </form>
        <?php $this->render_sync_status(is_array($site['sync'] ?? null) ? $site['sync'] : []); ?>
        <?php
    }

    private function render_sync_status(array $sync): void
    {
        $stats = is_array($sync['last_sync_stats'] ?? null) ? $sync['last_sync_stats'] : [];
        $summary_parts = [];
        foreach (['sites', 'imported', 'filtered', 'failed'] as $key) {
            if (isset($stats[$key]) && is_numeric($stats[$key])) {
                $summary_parts[] = sprintf(
                    '%s: %s',
                    ucfirst($key),
                    number_format_i18n((float) $stats[$key])
                );
            }
        }
        $summary = $summary_parts ? implode(', ', $summary_parts) : __('No run totals reported yet.', 'service-titan-job-post');
        $last_error = trim((string) ($sync['last_sync_error'] ?? ''));
        ?>
        <h2><?php esc_html_e('Sync health', 'service-titan-job-post'); ?></h2>
        <table class="widefat striped" style="max-width: 720px">
            <tbody>
                <tr>
                    <th><?php esc_html_e('Last successful sync', 'service-titan-job-post'); ?></th>
                    <td><?php echo esc_html((string) ($sync['last_successful_sync_at'] ?? '') ?: __('Never', 'service-titan-job-post')); ?></td>
                </tr>
                <tr>
                    <th><?php esc_html_e('Last attempt', 'service-titan-job-post'); ?></th>
                    <td><?php echo esc_html((string) ($sync['last_sync_attempt_at'] ?? '') ?: __('Never', 'service-titan-job-post')); ?></td>
                </tr>
                <tr>
                    <th><?php esc_html_e('Last status', 'service-titan-job-post'); ?></th>
                    <td><?php echo esc_html((string) ($sync['last_sync_status'] ?? '') ?: __('Not yet run', 'service-titan-job-post')); ?></td>
                </tr>
                <tr>
                    <th><?php esc_html_e('Last run totals', 'service-titan-job-post'); ?></th>
                    <td><?php echo esc_html($summary); ?></td>
                </tr>
                <?php if ('' !== $last_error) : ?>
                    <tr>
                        <th><?php esc_html_e('Last error', 'service-titan-job-post'); ?></th>
                        <td><?php echo esc_html($last_error); ?></td>
                    </tr>
                <?php endif; ?>
            </tbody>
        </table>
        <?php
    }

    private function render_editorial_queue_status(): void
    {
        $counts = wp_count_posts('st_job');
        $pending_count = isset($counts->pending) ? (int) $counts->pending : 0;
        $source_update_count = $this->source_update_count();
        $pending_url = add_query_arg([
            'post_type'   => 'st_job',
            'post_status' => 'pending',
        ], admin_url('edit.php'));
        $source_update_url = add_query_arg([
            'post_type'              => 'st_job',
            'st_sync_source_update'  => 'available',
        ], admin_url('edit.php'));
        ?>
        <h2><?php esc_html_e('Editorial queue', 'service-titan-job-post'); ?></h2>
        <table class="widefat striped" style="max-width: 720px">
            <tbody>
                <tr>
                    <th><?php esc_html_e('Pending review', 'service-titan-job-post'); ?></th>
                    <td>
                        <?php echo esc_html(number_format_i18n($pending_count)); ?>
                        <a href="<?php echo esc_url($pending_url); ?>"><?php esc_html_e('Review pending jobs', 'service-titan-job-post'); ?></a>
                    </td>
                </tr>
                <tr>
                    <th><?php esc_html_e('Source updates', 'service-titan-job-post'); ?></th>
                    <td>
                        <?php echo esc_html(number_format_i18n($source_update_count)); ?>
                        <a href="<?php echo esc_url($source_update_url); ?>"><?php esc_html_e('Review source updates', 'service-titan-job-post'); ?></a>
                    </td>
                </tr>
            </tbody>
        </table>
        <p class="description">
            <?php esc_html_e('Imported jobs stay pending until an editor reviews and publishes them. Later ServiceTitan changes are held here for review instead of overwriting approved copy.', 'service-titan-job-post'); ?>
        </p>
        <?php
    }

    private function source_update_count(): int
    {
        $query = new WP_Query([
            'post_type'      => 'st_job',
            'post_status'    => ['publish', 'pending', 'draft', 'private', 'future'],
            'posts_per_page' => 1,
            'fields'         => 'ids',
            'meta_query'     => [
                [
                    'key'   => 'st_job_update_available',
                    'value' => '1',
                ],
            ],
        ]);

        return (int) $query->found_posts;
    }

    private function render_location_page_coverage(): void
    {
        $rows = $this->location_page_coverage_rows();
        ?>
        <h2><?php esc_html_e('Location page coverage', 'service-titan-job-post'); ?></h2>
        <p class="description">
            <?php esc_html_e('Recent Local Jobs can auto-append to nested Pages whose slugs match imported service and location terms.', 'service-titan-job-post'); ?>
        </p>
        <?php if (empty($rows)) : ?>
            <p><?php esc_html_e('No imported job locations are available yet.', 'service-titan-job-post'); ?></p>
            <?php return; ?>
        <?php endif; ?>
        <table class="widefat striped" style="max-width: 900px">
            <thead>
                <tr>
                    <th><?php esc_html_e('Service / Location', 'service-titan-job-post'); ?></th>
                    <th><?php esc_html_e('Jobs found', 'service-titan-job-post'); ?></th>
                    <th><?php esc_html_e('Matching page', 'service-titan-job-post'); ?></th>
                </tr>
            </thead>
            <tbody>
                <?php foreach ($rows as $row) : ?>
                    <tr>
                        <td>
                            <?php echo esc_html($row['service_name'] . ' / ' . $row['location_name']); ?><br>
                            <code><?php echo esc_html('/' . $row['service_slug'] . '/' . $row['location_slug'] . '/'); ?></code>
                        </td>
                        <td><?php echo esc_html(number_format_i18n((int) $row['count'])); ?></td>
                        <td>
                            <?php if ($row['page_id']) : ?>
                                <a href="<?php echo esc_url(get_permalink((int) $row['page_id'])); ?>"><?php esc_html_e('View page', 'service-titan-job-post'); ?></a>
                                <?php $edit_link = get_edit_post_link((int) $row['page_id']); ?>
                                <?php if ($edit_link) : ?>
                                    · <a href="<?php echo esc_url($edit_link); ?>"><?php esc_html_e('Edit', 'service-titan-job-post'); ?></a>
                                <?php endif; ?>
                            <?php else : ?>
                                <strong><?php esc_html_e('Missing page', 'service-titan-job-post'); ?></strong>
                                <?php $create_url = wp_nonce_url(add_query_arg([
                                    'action'        => 'st_sync_create_location_page',
                                    'service_slug'  => $row['service_slug'],
                                    'location_slug' => $row['location_slug'],
                                ], admin_url('admin-post.php')), 'st_sync_create_location_page'); ?>
                                <br><a class="button button-small" href="<?php echo esc_url($create_url); ?>"><?php esc_html_e('Create draft page', 'service-titan-job-post'); ?></a>
                            <?php endif; ?>
                        </td>
                    </tr>
                <?php endforeach; ?>
            </tbody>
        </table>
        <?php
    }

    private function location_page_coverage_rows(): array
    {
        $query = new WP_Query([
            'post_type'              => 'st_job',
            'post_status'            => ['publish', 'pending', 'draft', 'private', 'future'],
            'posts_per_page'         => 250,
            'fields'                 => 'ids',
            'meta_key'               => 'st_job_date',
            'orderby'                => 'meta_value',
            'order'                  => 'DESC',
            'no_found_rows'          => true,
            'update_post_meta_cache' => true,
            'update_post_term_cache' => true,
        ]);

        $rows = [];
        foreach ($query->posts as $post_id) {
            $service = $this->first_term_info((int) $post_id, 'st_service');
            $location = $this->first_term_info((int) $post_id, 'st_location');
            $service_name = $service['name'] ?: (string) get_post_meta((int) $post_id, 'st_job_service', true);
            $location_name = $location['name'] ?: (string) get_post_meta((int) $post_id, 'st_job_city', true);
            $service_slug = $service['slug'] ?: sanitize_title($service_name);
            $location_slug = $location['slug'] ?: sanitize_title($location_name);
            if ('' === $service_slug || '' === $location_slug) {
                continue;
            }

            $key = $service_slug . '/' . $location_slug;
            if (! isset($rows[$key])) {
                $rows[$key] = [
                    'service_name'  => $service_name ?: $this->title_from_slug($service_slug),
                    'service_slug'  => $service_slug,
                    'location_name' => $location_name ?: $this->title_from_slug($location_slug),
                    'location_slug' => $location_slug,
                    'count'         => 0,
                    'page_id'       => $this->location_page_id($service_slug, $location_slug),
                ];
            }
            $rows[$key]['count']++;
        }

        return array_values($rows);
    }

    private function location_page_id(string $service_slug, string $location_slug): int
    {
        $page = get_page_by_path($service_slug . '/' . $location_slug, OBJECT, 'page');
        return $page instanceof WP_Post ? (int) $page->ID : 0;
    }

    public function create_location_page_action(): void
    {
        $this->authorize_action('st_sync_create_location_page');
        $service_slug = isset($_GET['service_slug']) ? sanitize_title(wp_unslash($_GET['service_slug'])) : '';
        $location_slug = isset($_GET['location_slug']) ? sanitize_title(wp_unslash($_GET['location_slug'])) : '';
        $result = $this->create_location_page($service_slug, $location_slug);
        $this->redirect_with_result($result, __('Draft location page created.', 'service-titan-job-post'));
    }

    /**
     * @return int|WP_Error
     */
    public function create_location_page(string $service_slug, string $location_slug)
    {
        $service_slug = sanitize_title($service_slug);
        $location_slug = sanitize_title($location_slug);
        if ('' === $service_slug || '' === $location_slug) {
            return new WP_Error('st_sync_invalid_page_slugs', __('Service and location slugs are required.', 'service-titan-job-post'));
        }

        $existing = $this->location_page_id($service_slug, $location_slug);
        if ($existing) {
            return $existing;
        }

        $service_page = get_page_by_path($service_slug, OBJECT, 'page');
        if (! $service_page instanceof WP_Post) {
            $service_page_id = wp_insert_post([
                'post_type'    => 'page',
                'post_status'  => 'draft',
                'post_title'   => $this->title_from_slug($service_slug),
                'post_name'    => $service_slug,
                'post_content' => '',
            ], true);
            if (is_wp_error($service_page_id)) {
                return $service_page_id;
            }
        } else {
            $service_page_id = (int) $service_page->ID;
        }

        $location_page_id = wp_insert_post([
            'post_type'    => 'page',
            'post_status'  => 'draft',
            'post_parent'  => (int) $service_page_id,
            'post_title'   => $this->title_from_slug($location_slug),
            'post_name'    => $location_slug,
            'post_content' => $this->recent_jobs_block_content($service_slug, $location_slug),
        ], true);

        return $location_page_id;
    }

    private function recent_jobs_block_content(string $service_slug, string $location_slug): string
    {
        $attributes = wp_json_encode([
            'serviceSlug'  => $service_slug,
            'locationSlug' => $location_slug,
        ], JSON_UNESCAPED_SLASHES);

        return '<!-- wp:st-sync/recent-jobs ' . ($attributes ?: '{}') . ' /-->';
    }

    private function render_connection_form(array $connection): void
    {
        $connected = ! empty($connection['connected']);
        ?>
        <h2><?php esc_html_e('ServiceTitan connection', 'service-titan-job-post'); ?></h2>
        <table class="widefat striped" style="max-width: 720px">
            <tbody>
                <tr>
                    <th><?php esc_html_e('Connection status', 'service-titan-job-post'); ?></th>
                    <td><?php echo esc_html($connected ? __('Connected', 'service-titan-job-post') : __('Not connected', 'service-titan-job-post')); ?></td>
                </tr>
                <?php if ($connected) : ?>
                    <tr>
                        <th><?php esc_html_e('Tenant ID', 'service-titan-job-post'); ?></th>
                        <td><?php echo esc_html((string) ($connection['tenant_id'] ?? '')); ?></td>
                    </tr>
                    <tr>
                        <th><?php esc_html_e('Environment', 'service-titan-job-post'); ?></th>
                        <td><?php echo esc_html((string) ($connection['environment'] ?? '')); ?></td>
                    </tr>
                    <tr>
                        <th><?php esc_html_e('Last saved', 'service-titan-job-post'); ?></th>
                        <td><?php echo esc_html((string) ($connection['updated_at'] ?? '')); ?></td>
                    </tr>
                <?php endif; ?>
            </tbody>
        </table>
        <p><?php esc_html_e('Credentials are sent over HTTPS to encrypted hosted storage and are not saved in WordPress.', 'service-titan-job-post'); ?></p>
        <form action="<?php echo esc_url(admin_url('admin-post.php')); ?>" method="post" autocomplete="off">
            <input type="hidden" name="action" value="st_sync_connect">
            <?php wp_nonce_field('st_sync_connect'); ?>
            <table class="form-table"><tbody>
                <tr>
                    <th><label for="st-environment"><?php esc_html_e('Environment', 'service-titan-job-post'); ?></label></th>
                    <td><select id="st-environment" name="environment"><option value="production"><?php esc_html_e('Production', 'service-titan-job-post'); ?></option><option value="integration"><?php esc_html_e('Integration', 'service-titan-job-post'); ?></option></select></td>
                </tr>
                <tr><th><label for="st-tenant-id"><?php esc_html_e('Tenant ID', 'service-titan-job-post'); ?></label></th><td><input id="st-tenant-id" name="tenant_id" class="regular-text" required></td></tr>
                <tr><th><label for="st-client-id"><?php esc_html_e('Client ID', 'service-titan-job-post'); ?></label></th><td><input id="st-client-id" name="client_id" class="regular-text" required autocomplete="off"></td></tr>
                <tr><th><label for="st-client-secret"><?php esc_html_e('Client secret', 'service-titan-job-post'); ?></label></th><td><input id="st-client-secret" type="password" name="client_secret" class="regular-text" required autocomplete="new-password"></td></tr>
            </tbody></table>
            <?php submit_button(__('Save ServiceTitan connection', 'service-titan-job-post')); ?>
        </form>
        <p class="description"><?php esc_html_e('Required scopes: Jobs (Read), Job Types (Read), and Locations (Read).', 'service-titan-job-post'); ?></p>
        <?php
    }

    private function add_field(string $id, string $title, string $type = 'text', string $description = ''): void
    {
        add_settings_field(
            $id,
            $title,
            [$this, 'render_field'],
            'st-sync-settings',
            'st_filter_section',
            ['id' => $id, 'type' => $type, 'description' => $description]
        );
    }

    private function render_job_update_button(int $post_id, string $action, string $label, string $type): void
    {
        ?>
        <form action="<?php echo esc_url(admin_url('admin-post.php')); ?>" method="post" style="display:inline-block;margin-right:8px">
            <input type="hidden" name="action" value="<?php echo esc_attr($action); ?>">
            <input type="hidden" name="post_id" value="<?php echo esc_attr((string) $post_id); ?>">
            <?php wp_nonce_field('st_sync_job_update_' . $post_id); ?>
            <?php submit_button($label, $type, 'submit', false); ?>
        </form>
        <?php
    }

    public function apply_job_update_action(): void
    {
        $post_id = $this->authorized_job_update_post_id();
        $result = $this->apply_pending_job_update($post_id);
        $this->redirect_after_job_update($post_id, $result, __('ServiceTitan source update applied.', 'service-titan-job-post'));
    }

    public function dismiss_job_update_action(): void
    {
        $post_id = $this->authorized_job_update_post_id();
        $result = $this->dismiss_pending_job_update($post_id);
        $this->redirect_after_job_update($post_id, $result, __('ServiceTitan source update dismissed.', 'service-titan-job-post'));
    }

    private function sanitize_date(string $date): string
    {
        $parsed = DateTimeImmutable::createFromFormat('!Y-m-d', $date);
        return $parsed && $parsed->format('Y-m-d') === $date
            ? $date
            : self::defaults()['jobs_since'];
    }

    private function render_checkout_interstitial(string $license_key, string $checkout_url): void
    {
        require_once ABSPATH . 'wp-admin/admin-header.php';
        ?>
        <div class="wrap">
            <h1><?php esc_html_e('Continue to subscription checkout', 'service-titan-job-post'); ?></h1>
            <div class="notice notice-warning inline"><p>
                <?php esc_html_e('Copy this license key before continuing. The plugin does not store it in WordPress, and you will need it after checkout completes.', 'service-titan-job-post'); ?>
            </p></div>
            <p><label for="st-issued-license-key"><strong><?php esc_html_e('License key', 'service-titan-job-post'); ?></strong></label></p>
            <p><input id="st-issued-license-key" type="text" class="large-text code" readonly value="<?php echo esc_attr($license_key); ?>" onclick="this.select();"></p>
            <p>
                <a class="button button-primary button-hero" href="<?php echo esc_url($checkout_url); ?>">
                    <?php esc_html_e('Continue to secure checkout', 'service-titan-job-post'); ?>
                </a>
                <a class="button button-secondary" href="<?php echo esc_url(admin_url('admin.php?page=st-sync-settings')); ?>">
                    <?php esc_html_e('Back to plugin settings', 'service-titan-job-post'); ?>
                </a>
            </p>
            <p class="description">
                <?php esc_html_e('After the Stripe subscription is active, paste this license key into the activation form on this settings page.', 'service-titan-job-post'); ?>
            </p>
        </div>
        <?php
        require_once ABSPATH . 'wp-admin/admin-footer.php';
        exit;
    }

    private function pending_job_update(int $post_id): array
    {
        if ('1' !== get_post_meta($post_id, 'st_job_update_available', true)) {
            return [];
        }

        return [
            'summary'       => (string) get_post_meta($post_id, 'st_job_pending_summary', true),
            'completed_on'  => (string) get_post_meta($post_id, 'st_job_pending_completed_on', true),
            'city'          => (string) get_post_meta($post_id, 'st_job_pending_city', true),
            'state'         => (string) get_post_meta($post_id, 'st_job_pending_state', true),
            'service_slug'  => (string) get_post_meta($post_id, 'st_job_pending_service_slug', true),
            'service_name'  => (string) get_post_meta($post_id, 'st_job_pending_service_name', true),
            'location_slug' => (string) get_post_meta($post_id, 'st_job_pending_location_slug', true),
            'location_id'   => (string) get_post_meta($post_id, 'st_job_pending_location_id', true),
            'job_type_id'   => (string) get_post_meta($post_id, 'st_job_pending_job_type_id', true),
            'job_type_name' => (string) get_post_meta($post_id, 'st_job_pending_job_type_name', true),
            'total'         => (string) get_post_meta($post_id, 'st_job_pending_total', true),
        ];
    }

    private function current_job_update_values(int $post_id): array
    {
        $summary = trim((string) get_post_field('post_excerpt', $post_id));
        if ('' === $summary) {
            $summary = (string) get_post_meta($post_id, 'st_job_summary', true);
        }
        $service_name = $this->term_names($post_id, 'st_service');
        if ('' === $service_name) {
            $service_name = (string) get_post_meta($post_id, 'st_job_service', true);
        }

        return [
            'summary'       => $summary,
            'completed_on'  => (string) get_post_meta($post_id, 'st_job_date', true),
            'city'          => (string) get_post_meta($post_id, 'st_job_city', true),
            'state'         => (string) get_post_meta($post_id, 'st_job_state', true),
            'service_name'  => $service_name,
            'location_slug' => $this->first_term_slug($post_id, 'st_location'),
            'job_type_name' => (string) get_post_meta($post_id, 'st_job_type_name', true),
        ];
    }

    private function clear_pending_job_update(int $post_id): void
    {
        update_post_meta($post_id, 'st_job_update_available', '0');
        foreach ([
            'st_job_pending_summary',
            'st_job_pending_completed_on',
            'st_job_pending_city',
            'st_job_pending_state',
            'st_job_pending_service_slug',
            'st_job_pending_service_name',
            'st_job_pending_location_slug',
            'st_job_pending_location_id',
            'st_job_pending_job_type_id',
            'st_job_pending_job_type_name',
            'st_job_pending_total',
        ] as $key) {
            delete_post_meta($post_id, $key);
        }
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

    private function title_from_slug(string $slug): string
    {
        return ucwords(str_replace('-', ' ', sanitize_title($slug)));
    }

    private function format_admin_date(string $date): string
    {
        $timestamp = strtotime($date);
        return false === $timestamp
            ? $date
            : wp_date(get_option('date_format'), $timestamp);
    }

    private function term_names(int $post_id, string $taxonomy): string
    {
        $terms = wp_get_post_terms($post_id, $taxonomy);
        if (is_wp_error($terms) || empty($terms)) {
            return '';
        }

        return implode(', ', wp_list_pluck($terms, 'name'));
    }

    private function first_term_slug(int $post_id, string $taxonomy): string
    {
        $terms = wp_get_post_terms($post_id, $taxonomy);
        if (is_wp_error($terms) || empty($terms)) {
            return '';
        }

        $first = reset($terms);
        return $first instanceof WP_Term ? (string) $first->slug : '';
    }

    private function first_term_info(int $post_id, string $taxonomy): array
    {
        $terms = wp_get_post_terms($post_id, $taxonomy);
        if (is_wp_error($terms) || empty($terms)) {
            return ['name' => '', 'slug' => ''];
        }

        $first = reset($terms);
        if (! $first instanceof WP_Term) {
            return ['name' => '', 'slug' => ''];
        }

        return [
            'name' => (string) $first->name,
            'slug' => (string) $first->slug,
        ];
    }

    private function has_job_details_block(int $post_id): bool
    {
        $content = (string) get_post_field('post_content', $post_id);
        return has_block('st-sync/job-details', $content);
    }

    private function authorized_job_update_post_id(): int
    {
        $post_id = isset($_POST['post_id']) ? (int) $_POST['post_id'] : 0;
        if ($post_id <= 0 || ! current_user_can('edit_post', $post_id)) {
            wp_die(
                esc_html__('You are not allowed to update this Local Job.', 'service-titan-job-post'),
                '',
                ['response' => 403]
            );
        }

        check_admin_referer('st_sync_job_update_' . $post_id);
        return $post_id;
    }

    private function redirect_after_job_update(int $post_id, $result, string $success_message): void
    {
        if (is_wp_error($result)) {
            $this->set_notice('error', $result->get_error_message());
        } else {
            $this->set_notice('success', $success_message);
        }
        wp_safe_redirect(get_edit_post_link($post_id, 'url') ?: admin_url('edit.php?post_type=st_job'));
        exit;
    }

    private function authorize_action(string $action): void
    {
        if (! current_user_can('manage_options')) {
            wp_die(
                esc_html__('You are not allowed to manage this integration.', 'service-titan-job-post'),
                '',
                ['response' => 403]
            );
        }
        check_admin_referer($action);
    }

    private function redirect_with_result($result, string $success_message): void
    {
        if (is_wp_error($result)) {
            $this->set_notice('error', $result->get_error_message());
        } else {
            $this->set_notice('success', $success_message);
        }
        wp_safe_redirect(admin_url('admin.php?page=st-sync-settings'));
        exit;
    }

    private function set_notice(string $type, string $message): void
    {
        set_transient('st_sync_admin_notice_' . get_current_user_id(), [
            'type'    => in_array($type, ['success', 'error', 'warning', 'info'], true) ? $type : 'info',
            'message' => sanitize_text_field($message),
        ], MINUTE_IN_SECONDS);
    }

    private function uses_plain_permalinks(): bool
    {
        return '' === (string) get_option('permalink_structure');
    }
}
